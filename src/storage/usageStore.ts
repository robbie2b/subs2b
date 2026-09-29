import crypto from 'crypto';
import { configStorage } from './configStore';
import { Logger } from '../utils/logger';

/**
 * Remembers WHEN each addon configuration is used (one row per subtitles request, i.e. per press on Play),
 * so the owner can see at which hours the addon is really needed. Stored in PostgreSQL when available
 * (survives restarts), otherwise only in memory. The owner is stored as a hash, never as the UUID.
 */

export interface UsageEvent {
  at: string;
  id: string;
  type: string;
  filename: string;
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
            filename TEXT NOT NULL DEFAULT ''
          );
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
export async function recordUsage(configKey: string, event: { id: string; type: string; filename?: string }): Promise<void> {
  try {
    const owner = ownerOf(configKey);
    const entry: UsageEvent = {
      at: new Date().toISOString(),
      id: event.id,
      type: event.type,
      filename: (event.filename || '').slice(0, 300)
    };

    const list = memory.get(owner) || [];
    list.unshift(entry);
    if (list.length > MAX_MEMORY_EVENTS) list.length = MAX_MEMORY_EVENTS;
    memory.set(owner, list);

    if (await ensureTable()) {
      const pool = await configStorage.getPool();
      await pool!.query(
        'INSERT INTO usage_events (owner, at, content_id, content_type, filename) VALUES ($1, $2, $3, $4, $5)',
        [owner, entry.at, entry.id, entry.type, entry.filename]
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
        'SELECT at, content_id, content_type, filename FROM usage_events WHERE owner = $1 ORDER BY at DESC LIMIT $2',
        [owner, MAX_ROWS_READ]
      );
      events = res.rows.map((r: any) => ({
        at: new Date(r.at).toISOString(),
        id: r.content_id,
        type: r.content_type,
        filename: r.filename
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
    recent: events.slice(0, 150)
  };
}
