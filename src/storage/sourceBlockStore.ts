import { configStorage } from './configStore';
import { ensureTableSafely } from './dbTools';
import { Logger } from '../utils/logger';
import { attachRefusalStore, restoreRefusals } from '../utils/sourceHealth';

/**
 * The sources refusing this server (see utils/sourceHealth), kept in PostgreSQL so a restart or a deploy remembers
 * them: an OpenSubtitles daily quota lasts until midnight UTC, Render restarts the server many times a day.
 */

let ready: Promise<boolean> | null = null;

async function ensureTable(): Promise<boolean> {
  if (!ready) {
    ready = (async () => {
      const pool = await configStorage.getPool();
      if (!pool) return false;
      try {
        await ensureTableSafely(pool, 'source_blocks', `
          CREATE TABLE IF NOT EXISTS source_blocks (
            source TEXT PRIMARY KEY,
            until TIMESTAMPTZ NOT NULL,
            reason TEXT NOT NULL DEFAULT ''
          )`);
        return true;
      } catch (err) {
        Logger.error('Could not prepare the source blocks table', err);
        ready = null;
        return false;
      }
    })();
  }
  return ready;
}

/** Reads the refusals still running and keeps the next ones. Never throws; when the table is not ready, tries again later. */
export async function startSourceBlockStore(): Promise<void> {
  try {
    if (!(await ensureTable())) {
      setTimeout(() => { void startSourceBlockStore(); }, 10 * 60 * 1000).unref();
      return;
    }
    const pool = await configStorage.getPool();
    const res = await pool!.query(`SELECT source, until, reason FROM source_blocks WHERE until > NOW()`);
    restoreRefusals(res.rows.map((r: any) => ({ source: r.source, until: new Date(r.until).getTime(), reason: r.reason })));
    if (res.rows.length) Logger.info(`[SOURCES] ${res.rows.length} source(s) still refusing this server, remembered from before the restart`, { sources: res.rows.map((r: any) => r.source) });
    attachRefusalStore({
      save(source, until, reason) {
        void pool!.query(
          `INSERT INTO source_blocks (source, until, reason) VALUES ($1, $2, $3)
           ON CONFLICT (source) DO UPDATE SET until = EXCLUDED.until, reason = EXCLUDED.reason`,
          [source, new Date(until).toISOString(), reason.slice(0, 300)]
        ).catch(err => Logger.error('Could not save a source block', err));
      }
    });
  } catch (err) {
    Logger.error('Could not read the source blocks', err);
  }
}
