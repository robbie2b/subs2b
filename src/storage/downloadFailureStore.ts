import { configStorage } from './configStore';
import { ensureTableSafely } from './dbTools';
import { Logger } from '../utils/logger';
import { attachDownloadFailureStore, restoreDownloadFailures, DownloadFailure } from '../utils/downloadJournal';

/**
 * The journal of failed downloads (utils/downloadJournal), kept in PostgreSQL for 30 days so Debug still shows it after
 * a restart or a deploy. Read in the background after the server is listening; never awaited before it.
 */

const KEEP_DAYS = 30;

export async function startDownloadFailureStore(): Promise<void> {
  try {
    const pool = await configStorage.getPool();
    if (!pool) return;
    try {
      await ensureTableSafely(pool, 'download_failures', `
        CREATE TABLE IF NOT EXISTS download_failures (
          id BIGSERIAL PRIMARY KEY,
          at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          host TEXT NOT NULL,
          place TEXT NOT NULL,
          reason TEXT NOT NULL DEFAULT '',
          recovered BOOLEAN NOT NULL DEFAULT FALSE,
          release TEXT
        );
        CREATE INDEX IF NOT EXISTS download_failures_at ON download_failures (at)`);
    } catch (err) {
      Logger.error('Could not prepare the download failures table, trying again in 10 min', err);
      setTimeout(() => { void startDownloadFailureStore(); }, 10 * 60 * 1000).unref();
      return;
    }
    await pool.query(`DELETE FROM download_failures WHERE at < NOW() - INTERVAL '${KEEP_DAYS} days'`);
    const res = await pool.query(`SELECT at, host, place, reason, recovered, release FROM download_failures ORDER BY at DESC LIMIT 300`);
    restoreDownloadFailures(res.rows.map((r: any): DownloadFailure => ({
      at: new Date(r.at).toISOString(), host: r.host, place: r.place, reason: r.reason, recovered: r.recovered,
      ...(r.release ? { release: r.release } : {})
    })));
    Logger.info(`[DOWNLOAD] ${res.rows.length} saved download failure(s) read`);
    attachDownloadFailureStore(f => {
      void pool.query(
        `INSERT INTO download_failures (at, host, place, reason, recovered, release) VALUES ($1, $2, $3, $4, $5, $6)`,
        [f.at, f.host, f.place, f.reason, f.recovered, f.release || null]
      ).catch(err => Logger.error('Could not save a download failure', err));
    });
  } catch (err) {
    Logger.error('Could not read the download failures', err);
  }
}
