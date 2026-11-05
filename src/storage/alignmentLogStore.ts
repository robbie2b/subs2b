import { configStorage } from './configStore';
import { enableRlsSql } from './dbTools';
import { ownerOf } from './usageStore';
import { Logger } from '../utils/logger';
import { keepAlive } from '../utils/background';

/**
 * What the automatic re-timing (Subsync) decided, kept for the Debug page.
 * Stored in PostgreSQL when available (survives restarts, like the usage history), otherwise only in memory.
 */

/** Where the time went for one subtitle (ms). All are counted from the start of its preparation, except the last two. */
export interface AlignmentTiming {
  /** the subtitle's own download */
  subtitleMs: number;
  /** the references: stored ones, or searched and downloaded */
  referencesMs: number;
  /** the computation */
  computeMs: number;
  /** until the aligned subtitle was ready to be served */
  readyAfterMs: number;
  /** until the player asked for it (a subtitle prepared in advance is asked for some seconds after the list) */
  askedAfterMs: number;
  /** how long the player waited for the answer */
  waitedMs: number;
}

export interface AlignmentLogEntry {
  at: string;
  id: string;
  filename: string;
  subtitle: string;
  outcome: 'shifted' | 'unchanged' | 'timeout' | 'error';
  offset: number;
  /** frame-rate stretch applied (1 = none) and number of separately shifted parts (0 = nothing applied) */
  ratio?: number;
  segments?: number;
  confidence: number;
  reason: string;
  references: Array<{ label: string; provider?: string; offset: number; score: number; ratio?: number; segments?: number }>;
  /** release name of the alternative served instead, when the subtitle did not fit the references */
  replacedBy?: string;
  /** where the time went (absent in older decisions) */
  timing?: AlignmentTiming;
  ms: number;
}

const MAX_MEMORY = 200;
const READ_LIMIT = 200;
const RETENTION_DAYS = 90;
const memory = new Map<string, AlignmentLogEntry[]>();
let tableReady: Promise<boolean> | null = null;

async function ensureTable(): Promise<boolean> {
  if (!tableReady) {
    tableReady = (async () => {
      const pool = await configStorage.getPool();
      if (!pool) return false;
      try {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS subsync_decisions (
            id BIGSERIAL PRIMARY KEY,
            owner VARCHAR(32) NOT NULL,
            at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            content_id TEXT NOT NULL DEFAULT '',
            filename TEXT NOT NULL DEFAULT '',
            subtitle TEXT NOT NULL DEFAULT '',
            outcome VARCHAR(16) NOT NULL,
            offset_sec REAL NOT NULL DEFAULT 0,
            ratio REAL NOT NULL DEFAULT 1,
            segments INTEGER NOT NULL DEFAULT 0,
            confidence REAL NOT NULL DEFAULT 0,
            reason TEXT NOT NULL DEFAULT '',
            refs JSONB,
            ms INTEGER NOT NULL DEFAULT 0
          );
          ALTER TABLE subsync_decisions ADD COLUMN IF NOT EXISTS ratio REAL NOT NULL DEFAULT 1;
          ALTER TABLE subsync_decisions ADD COLUMN IF NOT EXISTS segments INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE subsync_decisions ADD COLUMN IF NOT EXISTS replaced_by TEXT;
          ALTER TABLE subsync_decisions ADD COLUMN IF NOT EXISTS timing JSONB;
          CREATE INDEX IF NOT EXISTS idx_subsync_decisions_owner_at ON subsync_decisions(owner, at DESC);
          ${enableRlsSql('subsync_decisions')};
        `);
        return true;
      } catch (err) {
        Logger.error('Could not prepare the Subsync decisions table', err);
        return false;
      }
    })();
  }
  return tableReady;
}

/** Remembers one decision. Never throws and never blocks the response. */
export function recordAlignment(configKey: string, entry: AlignmentLogEntry): void {
  const owner = ownerOf(configKey);
  const list = memory.get(owner) || [];
  list.unshift(entry);
  if (list.length > MAX_MEMORY) list.length = MAX_MEMORY;
  memory.set(owner, list);

  // (kept alive on Vercel: the instance may be frozen as soon as the answer is out, in the middle of the write)
  keepAlive((async () => {
    try {
      if (!(await ensureTable())) return;
      const pool = await configStorage.getPool();
      await pool!.query(
        `INSERT INTO subsync_decisions (owner, at, content_id, filename, subtitle, outcome, offset_sec, ratio, segments, confidence, reason, refs, ms, replaced_by, timing)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [owner, entry.at, entry.id, entry.filename.slice(0, 300), entry.subtitle.slice(0, 300), entry.outcome,
          entry.offset, entry.ratio ?? 1, entry.segments ?? 0, entry.confidence, entry.reason.slice(0, 300), JSON.stringify(entry.references), entry.ms, entry.replacedBy ? entry.replacedBy.slice(0, 300) : null, entry.timing ? JSON.stringify(entry.timing) : null]
      );
      if (Math.random() < 0.02) {
        await pool!.query(
          `DELETE FROM subsync_decisions WHERE owner = $1 AND at < NOW() - INTERVAL '${RETENTION_DAYS} days'`,
          [owner]
        );
      }
    } catch (err) {
      Logger.error('Could not record a Subsync decision', err);
    }
  })());
}

/** The latest decisions, newest first */
export async function getAlignments(configKey: string): Promise<AlignmentLogEntry[]> {
  const owner = ownerOf(configKey);
  try {
    if (await ensureTable()) {
      const pool = await configStorage.getPool();
      const res = await pool!.query(
        `SELECT at, content_id, filename, subtitle, outcome, offset_sec, ratio, segments, confidence, reason, refs, ms, replaced_by, timing
         FROM subsync_decisions WHERE owner = $1 ORDER BY at DESC, id DESC LIMIT $2`,
        [owner, READ_LIMIT]
      );
      return res.rows.map((r: any) => ({
        at: new Date(r.at).toISOString(),
        id: r.content_id,
        filename: r.filename,
        subtitle: r.subtitle,
        outcome: r.outcome,
        offset: Number(r.offset_sec),
        ratio: Number(r.ratio),
        segments: Number(r.segments),
        confidence: Number(r.confidence),
        reason: r.reason,
        references: r.refs || [],
        ...(r.replaced_by ? { replacedBy: r.replaced_by } : {}),
        ...(r.timing ? { timing: r.timing } : {}),
        ms: r.ms
      }));
    }
  } catch (err) {
    Logger.error('Could not read the Subsync decisions', err);
  }
  return memory.get(owner) || [];
}
