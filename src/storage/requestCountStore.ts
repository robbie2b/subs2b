import { configStorage } from './configStore';
import { ensureTableSafely, addColumnSafely } from './dbTools';
import type { CountRow } from '../utils/requestCounter';
import { Logger } from '../utils/logger';
import { keepAlive } from '../utils/background';

/** Requests per host and day (see utils/requestCounter), summed over every server instance; 30 days kept */

let tableReady: Promise<boolean> | null = null;

function ensureTable(): Promise<boolean> {
  if (!tableReady) {
    tableReady = (async () => {
      const pool = await configStorage.getPool();
      if (!pool) return false;
      await ensureTableSafely(pool, 'request_counts', `
        CREATE TABLE IF NOT EXISTS request_counts (
          day DATE NOT NULL,
          host TEXT NOT NULL,
          n INTEGER NOT NULL DEFAULT 0,
          owner TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (day, host, owner)
        )`);
      // made before the profiles were kept apart: counted per profile from now on (the old totals mixed them: dropped)
      await addColumnSafely(pool, 'request_counts', 'owner', [
        "ALTER TABLE request_counts ADD COLUMN owner TEXT NOT NULL DEFAULT ''",
        'DELETE FROM request_counts',
        'ALTER TABLE request_counts DROP CONSTRAINT IF EXISTS request_counts_pkey',
        'ALTER TABLE request_counts ADD PRIMARY KEY (day, host, owner)'
      ]);
      return true;
    })().catch(err => {
      Logger.error('Could not prepare the request counts table, trying again in 30 s', err);
      setTimeout(() => { tableReady = null; }, 30000).unref();
      return false;
    });
  }
  return tableReady;
}

/** Adds a batch of counts (one query). Never throws; kept alive on Vercel until written. */
export function saveRequestCounts(batch: CountRow[]): void {
  if (!batch.length) return;
  keepAlive((async () => {
    try {
      if (!(await ensureTable())) return;
      const pool = await configStorage.getPool();
      const values: unknown[] = [];
      const rows = batch.map((b, i) => { values.push(b.day, b.host.slice(0, 200), b.n, b.owner); return `($${i * 4 + 1}::date, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`; });
      await pool!.query(
        `INSERT INTO request_counts (day, host, n, owner) VALUES ${rows.join(', ')}
         ON CONFLICT (day, host, owner) DO UPDATE SET n = request_counts.n + EXCLUDED.n`, values);
      if (Math.random() < 0.02) await pool!.query(`DELETE FROM request_counts WHERE day < CURRENT_DATE - 30`);
    } catch (err) {
      Logger.error('Could not save the request counts', err);
    }
  })());
}

/** The counts of the last `days` days (UTC), from the database; null without one */
export async function readRequestCounts(days: number, viewer: string): Promise<Array<{ day: string; host: string; n: number }> | null> {
  try {
    if (!(await ensureTable())) return null;
    const pool = await configStorage.getPool();
    const res = await pool!.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, host, n FROM request_counts WHERE day > CURRENT_DATE - $1::int AND owner = $2 ORDER BY day DESC, n DESC`, [days, viewer]);
    return res.rows.map((r: any) => ({ day: r.day, host: r.host, n: Number(r.n) }));
  } catch (err) {
    Logger.error('Could not read the request counts', err);
    return null;
  }
}
