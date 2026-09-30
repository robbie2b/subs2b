import crypto from 'crypto';
import { configStorage } from './configStore';
import { Logger } from '../utils/logger';
import { providerKind, ProviderKind } from '../providers/kind';

/**
 * Remembers WHEN each addon configuration is used (one row per subtitles request, i.e. per press on Play),
 * so the owner can see at which hours the addon is really needed. Stored in PostgreSQL when available
 * (survives restarts), otherwise only in memory. The owner is stored as a hash, never as the UUID.
 */

/** Summary of how one request was answered (see aggregator): counts per step and the ranked top of the list */
export interface UsageDetails {
  rawTotal: number;
  rawByProvider: Record<string, number>;
  afterLanguage: number;
  afterDedup: number;
  afterScoring: number;
  shown: number;
  usedFilename: boolean;
  scoringFallback: boolean;
  top: Array<{ rank: number; score: number; rejected: boolean; provider: string; release: string; reasons: string[] }>;
  /** how each provider did in this search (absent when the answer came from the cache) */
  providers?: Array<{ id: string; name: string; ms: number; ok: boolean; count: number; error?: string }>;
  cached?: boolean;
}

export interface UsageEvent {
  at: string;
  id: string;
  type: string;
  filename: string;
  details?: UsageDetails;
}

export interface UsageSummary {
  tz: string;
  total: number;
  since: string | null;
  persistent: boolean;
  byHour: number[];
  byDayHour: number[][];
  recent: UsageEvent[];
}

const MAX_MEMORY_EVENTS = 5000;
const MAX_ROWS_READ = 20000;
const RETENTION_DAYS = 90;
const RECENT_LIMIT = 150;
const memory = new Map<string, UsageEvent[]>();
let tableReady: Promise<boolean> | null = null;

const ownerOf = (configKey: string): string =>
  crypto.createHash('sha256').update(configKey.toLowerCase()).digest('hex').slice(0, 16);

async function ensureTable(): Promise<boolean> {
  if (!tableReady) {
    tableReady = (async () => {
      const pool = await configStorage.getPool();
      if (!pool) return false;
      try {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS usage_events (
            id BIGSERIAL PRIMARY KEY,
            owner VARCHAR(32) NOT NULL,
            at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            content_id TEXT NOT NULL DEFAULT '',
            content_type TEXT NOT NULL DEFAULT '',
            filename TEXT NOT NULL DEFAULT '',
            details JSONB
          );
          ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS details JSONB;
          CREATE INDEX IF NOT EXISTS idx_usage_events_owner_at ON usage_events(owner, at DESC);
        `);
        return true;
      } catch (err) {
        Logger.error('Could not prepare the usage table', err);
        return false;
      }
    })();
  }
  return tableReady;
}

/** Records one subtitles request. Never throws and never blocks the response for long. */
export async function recordUsage(configKey: string, event: { id: string; type: string; filename?: string; details?: UsageDetails }): Promise<void> {
  try {
    const owner = ownerOf(configKey);
    const entry: UsageEvent = {
      at: new Date().toISOString(),
      id: event.id,
      type: event.type,
      filename: (event.filename || '').slice(0, 300),
      details: event.details
    };

    const list = memory.get(owner) || [];
    list.unshift(entry);
    if (list.length > MAX_MEMORY_EVENTS) list.length = MAX_MEMORY_EVENTS;
    memory.set(owner, list);

    if (await ensureTable()) {
      const pool = await configStorage.getPool();
      await pool!.query(
        'INSERT INTO usage_events (owner, at, content_id, content_type, filename, details) VALUES ($1, $2, $3, $4, $5, $6)',
        [owner, entry.at, entry.id, entry.type, entry.filename, entry.details ? JSON.stringify(entry.details) : null]
      );
      if (Math.random() < 0.02) {
        await pool!.query(
          `DELETE FROM usage_events WHERE owner = $1 AND at < NOW() - INTERVAL '${RETENTION_DAYS} days'`,
          [owner]
        );
      }
    }
  } catch (err) {
    Logger.error('Could not record usage', err);
  }
}

function validTimeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return tz;
  } catch {
    return 'Europe/Bucharest';
  }
}

export async function getUsage(configKey: string, tzInput?: string): Promise<UsageSummary> {
  const tz = validTimeZone(tzInput || 'Europe/Bucharest');
  const owner = ownerOf(configKey);
  let events: UsageEvent[] = memory.get(owner) || [];
  let persistent = false;

  if (await ensureTable()) {
    try {
      const pool = await configStorage.getPool();
      const res = await pool!.query(
        // the ranked details are only needed for the rows the page lists, not for the whole history
        `SELECT at, content_id, content_type, filename,
                CASE WHEN ROW_NUMBER() OVER (ORDER BY at DESC) <= $3 THEN details END AS details
         FROM usage_events WHERE owner = $1 ORDER BY at DESC LIMIT $2`,
        [owner, MAX_ROWS_READ, RECENT_LIMIT]
      );
      events = res.rows.map((r: any) => ({
        at: new Date(r.at).toISOString(),
        id: r.content_id,
        type: r.content_type,
        filename: r.filename,
        details: r.details || undefined
      }));
      persistent = true;
    } catch (err) {
      Logger.error('Could not read usage', err);
    }
  }

  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', hourCycle: 'h23' });
  const dayIndex: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const byHour = new Array(24).fill(0);
  const byDayHour: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));

  for (const e of events) {
    const p = parts.formatToParts(new Date(e.at));
    const day = dayIndex[p.find(x => x.type === 'weekday')?.value || ''];
    const hour = parseInt(p.find(x => x.type === 'hour')?.value || '', 10);
    if (day === undefined || isNaN(hour)) continue;
    byHour[hour]++;
    byDayHour[day][hour]++;
  }

  return {
    tz,
    total: events.length,
    since: events.length ? events[events.length - 1].at : null,
    persistent,
    byHour,
    byDayHour,
    recent: events.slice(0, RECENT_LIMIT)
  };
}

export interface ProviderStat {
  id: string;
  name: string;
  /** 'service' = built into subs2b, 'addon' = imported Stremio addon */
  kind: ProviderKind;
  /** searches in which the provider really ran (cached answers excluded) */
  searches: number;
  failures: number;
  successRate: number;
  avgMs: number;
  medianMs: number;
  maxMs: number;
  /** average number of subtitles the provider returned per search */
  avgFound: number;
  /** searches where it returned nothing without failing */
  emptyRate: number;
  lastAt: string | null;
  lastOk: boolean | null;
  lastError: string | null;
  /** requests (with a ranking) where the provider had at least one subtitle in the ranked top */
  inTop: number;
  /** requests where its subtitle was ranked first */
  wins: number;
  /** average number of its subtitles among the ones sent to the player, per request */
  avgSent: number;
  /** average score of its best accepted subtitle, over requests where it had one */
  avgBestScore: number | null;
  hashMatches: number;
}

export interface ProviderStats {
  requests: number;
  withRanking: number;
  since: string | null;
  providers: ProviderStat[];
}

const STATS_ROWS = 1000;

/** Aggregates the stored request details of the latest requests into one line per provider */
export async function getProviderStats(configKey: string): Promise<ProviderStats> {
  const owner = ownerOf(configKey);
  let events: UsageEvent[] = (memory.get(owner) || []).slice(0, STATS_ROWS);

  if (await ensureTable()) {
    try {
      const pool = await configStorage.getPool();
      const res = await pool!.query(
        'SELECT at, details FROM usage_events WHERE owner = $1 AND details IS NOT NULL ORDER BY at DESC LIMIT $2',
        [owner, STATS_ROWS]
      );
      events = res.rows.map((r: any) => ({ at: new Date(r.at).toISOString(), id: '', type: '', filename: '', details: r.details }));
    } catch (err) {
      Logger.error('Could not read provider statistics', err);
    }
  }
  return computeProviderStats(events);
}

export function computeProviderStats(events: UsageEvent[]): ProviderStats {
  interface Acc {
    name: string; times: number[]; found: number; failures: number; empty: number;
    lastAt: string | null; lastOk: boolean | null; lastError: string | null;
    inTop: number; wins: number; sent: number; bestScores: number[]; hash: number;
  }
  const acc = new Map<string, Acc>();
  const get = (id: string, name: string): Acc => {
    let a = acc.get(id);
    if (!a) {
      a = { name, times: [], found: 0, failures: 0, empty: 0, lastAt: null, lastOk: null, lastError: null, inTop: 0, wins: 0, sent: 0, bestScores: [], hash: 0 };
      acc.set(id, a);
    }
    if (name) a.name = name;
    return a;
  };

  const withDetails = events.filter(e => e.details);
  let withRanking = 0;

  // events are newest first: the first time a provider shows up is its latest search
  for (const e of withDetails) {
    const d = e.details!;

    for (const p of d.providers || []) {
      const a = get(p.id, p.name);
      a.times.push(p.ms);
      a.found += p.count;
      if (!p.ok) a.failures++;
      else if (p.count === 0) a.empty++;
      if (a.lastAt === null) {
        a.lastAt = e.at;
        a.lastOk = p.ok;
        a.lastError = p.ok ? null : (p.error || 'failed');
      }
    }

    const ranked = d.top.filter(t => !t.rejected);
    if (ranked.length === 0) continue;
    withRanking++;
    const best = new Map<string, number>();
    for (const t of ranked) {
      if (!best.has(t.provider)) best.set(t.provider, t.score);
      const a = get(t.provider, '');
      if (t.rank <= d.shown) a.sent++;
      if (t.reasons.some(r => /hash/i.test(r))) a.hash++;
    }
    for (const [id, score] of best) {
      const a = get(id, '');
      a.inTop++;
      a.bestScores.push(score);
    }
    get(ranked[0].provider, '').wins++;
  }

  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const median = (xs: number[]) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const round = (n: number, digits = 0) => Math.round(n * 10 ** digits) / 10 ** digits;

  const providers: ProviderStat[] = [...acc.entries()].map(([id, a]) => {
    const searches = a.times.length;
    return {
      id,
      name: a.name || id,
      kind: providerKind(id),
      searches,
      failures: a.failures,
      successRate: searches ? round((searches - a.failures) / searches, 3) : 0,
      avgMs: round(avg(a.times)),
      medianMs: round(median(a.times)),
      maxMs: a.times.length ? Math.max(...a.times) : 0,
      avgFound: searches ? round(a.found / searches, 1) : 0,
      emptyRate: searches ? round(a.empty / searches, 3) : 0,
      lastAt: a.lastAt,
      lastOk: a.lastOk,
      lastError: a.lastError,
      inTop: a.inTop,
      wins: a.wins,
      avgSent: withRanking ? round(a.sent / withRanking, 2) : 0,
      avgBestScore: a.bestScores.length ? round(avg(a.bestScores)) : null,
      hashMatches: a.hash
    };
  }).sort((x, y) => y.wins - x.wins || y.inTop - x.inTop || y.searches - x.searches);

  return {
    requests: withDetails.length,
    withRanking,
    since: events.length ? events[events.length - 1].at : null,
    providers
  };
}
