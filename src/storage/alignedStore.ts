import zlib from 'zlib';
import { configStorage } from './configStore';
import { ensureTableSafely } from './dbTools';
import { Logger } from '../utils/logger';
import { keepAlive } from '../utils/background';

/**
 * Subsync results kept in PostgreSQL, shared by all server instances: for one aligned link (subtitle + file) the
 * original text and the decision. The next request for the same link, on any instance, is answered from here, with
 * no download, no references and no computation.
 *
 * Limited by SIZE, not by time: the table may grow up to a budget (MB); when it passes the budget, the entries used
 * least recently are deleted until it is back under ~85% of it. Every read marks the entry as used (at most once
 * an hour per entry, to spare writes), so what people keep playing stays and what nobody opens any more goes first.
 * A far-out age limit (STALE_DAYS) only guards against a decision made with references that were replaced long ago.
 */

const budgetBytes = (): number => Math.max(5, parseFloat(process.env.ALIGNED_CACHE_MB || '') || 150) * 1048576;
const TRIM_TO = 0.85;
const STALE_DAYS = 45;
const TOUCH_EVERY_MS = 60 * 60 * 1000;
/** the lookup waits at most this long: a slow database must not slow the subtitle down */
export const READ_CAP_MS = 150;
/** a check of the total size is made after about this many writes (one query over an index-free sum is cheap) */
const CHECK_EVERY_WRITES = 10;

let tableReady: Promise<boolean> | null = null;
let writesSinceCheck = 0;

async function ensureTable(): Promise<boolean> {
  if (!tableReady) {
    tableReady = (async () => {
      const pool = await configStorage.getPool();
      if (!pool) return false;
      try {
        await ensureTableSafely(pool, 'aligned_cache', `
          CREATE TABLE IF NOT EXISTS aligned_cache (
            cache_key TEXT PRIMARY KEY,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_used TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            bytes INTEGER NOT NULL,
            data BYTEA NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_aligned_cache_used ON aligned_cache(last_used)`);
        return true;
      } catch (err) {
        Logger.error('Could not prepare the Subsync results table (tried again in 10 min)', err);
        setTimeout(() => { tableReady = null; }, 10 * 60 * 1000).unref();
        return false;
      }
    })();
  }
  return tableReady;
}

/** What is kept for one link */
export interface StoredAligned {
  /** the original subtitle as clean SRT */
  original: string;
  /** the served result (decision + the alternative's text when one took the place) */
  served: { result: unknown; text?: string; replacedBy?: string };
}

export function packAligned(value: StoredAligned): Buffer {
  return zlib.gzipSync(Buffer.from(JSON.stringify(value)));
}

export function unpackAligned(data: Buffer): StoredAligned {
  return JSON.parse(zlib.gunzipSync(data).toString('utf8')) as StoredAligned;
}

const withCap = <T>(work: Promise<T>, ms: number): Promise<T | null> =>
  new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    work.then(v => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(null); });
  });

/** The stored result for a link, or null (nothing stored, no database, or not read within the cap). Never throws. */
export function loadAligned(key: string, capMs: number = READ_CAP_MS): Promise<StoredAligned | null> {
  return withCap((async () => {
    if (!(await ensureTable())) return null;
    const pool = await configStorage.getPool();
    const res = await pool!.query(
      `SELECT data, last_used FROM aligned_cache WHERE cache_key = $1 AND created_at > NOW() - INTERVAL '${STALE_DAYS} days'`,
      [key]
    );
    if (res.rows.length === 0) return null;
    const stored = unpackAligned(res.rows[0].data as Buffer);
    // used again: moved up in the "recently used" order (not on every read)
    if (Date.now() - new Date(res.rows[0].last_used as string).getTime() > TOUCH_EVERY_MS) {
      keepAlive(pool!.query('UPDATE aligned_cache SET last_used = NOW() WHERE cache_key = $1', [key]).catch(() => undefined));
    }
    return stored;
  })(), capMs);
}

/**
 * Deletes the least recently used entries while the table is over its budget. Returns how many were deleted.
 * (Exported for the tests.)
 */
export async function trimAligned(budget: number = budgetBytes()): Promise<number> {
  const pool = await configStorage.getPool();
  if (!pool) return 0;
  const total = Number((await pool.query('SELECT COALESCE(SUM(bytes), 0)::bigint AS n FROM aligned_cache')).rows[0].n);
  if (total <= budget) return 0;
  const target = Math.floor(budget * TRIM_TO);
  // oldest use first, until the total that remains is under the target
  const res = await pool.query(
    `DELETE FROM aligned_cache WHERE cache_key IN (
       SELECT cache_key FROM (
         SELECT cache_key, SUM(bytes) OVER (ORDER BY last_used DESC, cache_key) AS running FROM aligned_cache
       ) t WHERE running > $1
     )`,
    [target]
  );
  Logger.info(`[CACHE] Subsync results over budget (${Math.round(total / 1048576)} MB > ${Math.round(budget / 1048576)} MB): deleted the ${res.rowCount} least recently used`);
  return res.rowCount || 0;
}

/** Keeps a result. Never throws and never blocks the response. */
export function storeAligned(key: string, value: StoredAligned): void {
  keepAlive((async () => {
    try {
      if (!(await ensureTable())) return;
      const pool = await configStorage.getPool();
      const data = packAligned(value);
      await pool!.query(
        `INSERT INTO aligned_cache (cache_key, bytes, data) VALUES ($1, $2, $3)
         ON CONFLICT (cache_key) DO UPDATE SET data = EXCLUDED.data, bytes = EXCLUDED.bytes, created_at = NOW(), last_used = NOW()`,
        [key, data.length, data]
      );
      if (++writesSinceCheck >= CHECK_EVERY_WRITES) {
        writesSinceCheck = 0;
        await trimAligned();
      }
    } catch (err) {
      Logger.error('Could not store a Subsync result', err);
    }
  })());
}

/** Forgets a result (the references it was decided with were replaced). Never throws. */
export function forgetAligned(key: string): void {
  keepAlive((async () => {
    try {
      if (!(await ensureTable())) return;
      const pool = await configStorage.getPool();
      await pool!.query('DELETE FROM aligned_cache WHERE cache_key = $1', [key]);
    } catch {
      // not important
    }
  })());
}
