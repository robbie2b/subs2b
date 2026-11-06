import { configStorage } from './configStore';
import { ensureTableSafely } from './dbTools';
import { Logger, INSTANCE_ID } from '../utils/logger';
import { keepAlive } from '../utils/background';
import type { ActivityEvent } from '../utils/activity';

/**
 * The Live activity steps in PostgreSQL, so every server instance (Vercel runs several) shows the same ones.
 * Written in small batches (one query per ~200 ms of activity, not one per step) and kept for 24 hours only.
 * Without a database nothing is stored and the page reads the memory of the instance that answers.
 */

const KEEP_HOURS = 24;
const FLUSH_MS = 200;
const READ_ROWS = 400;

let tableReady: Promise<boolean> | null = null;

function ensureTable(): Promise<boolean> {
  if (!tableReady) {
    tableReady = (async () => {
      const pool = await configStorage.getPool();
      if (!pool) return false;
      await ensureTableSafely(pool, 'activity_events', `
        CREATE TABLE IF NOT EXISTS activity_events (
          id BIGSERIAL PRIMARY KEY,
          at TIMESTAMPTZ NOT NULL,
          instance TEXT NOT NULL,
          kind TEXT NOT NULL,
          film TEXT NOT NULL,
          text TEXT NOT NULL,
          meta JSONB
        );
        CREATE INDEX IF NOT EXISTS activity_events_at ON activity_events (at)`);
      return true;
    })().catch(err => {
      Logger.error('Could not prepare the activity table, trying again in 30 s', err);
      setTimeout(() => { tableReady = null; }, 30000).unref();
      return false;
    });
  }
  return tableReady;
}

let queue: ActivityEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

async function flush(): Promise<void> {
  const batch = queue;
  queue = [];
  timer = null;
  if (!batch.length || !(await ensureTable())) return;
  try {
    const pool = await configStorage.getPool();
    const values: unknown[] = [];
    const rows = batch.map((e, i) => {
      const o = i * 6;
      values.push(e.at, INSTANCE_ID, e.kind, e.film.slice(0, 200), e.text.slice(0, 400), e.meta ? JSON.stringify(e.meta) : null);
      return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6})`;
    });
    await pool!.query(`INSERT INTO activity_events (at, instance, kind, film, text, meta) VALUES ${rows.join(', ')}`, values);
    if (Math.random() < 0.02) await pool!.query(`DELETE FROM activity_events WHERE at < NOW() - INTERVAL '${KEEP_HOURS} hours'`);
  } catch (err) {
    Logger.error('Could not save the live activity', err);
  }
}

/** Queues one step to be saved (never throws, never waits) */
export function persistActivity(event: ActivityEvent): void {
  queue.push(event);
  if (timer) return;
  // (kept alive on Vercel until it is written)
  keepAlive(new Promise<void>(resolve => {
    timer = setTimeout(() => { flush().finally(resolve); }, FLUSH_MS);
  }));
}

/**
 * The saved steps newer than `afterId` (0 = the latest ones), from every instance; null when there is no database or it
 * cannot be read (the caller then answers from memory).
 */
export async function readStoredActivity(afterId: number): Promise<{ events: Array<ActivityEvent & { seq: number }>; last: number; instance: string } | null> {
  try {
    if (!(await ensureTable())) return null;
    const pool = await configStorage.getPool();
    const res = afterId > 0
      ? await pool!.query('SELECT id, at, kind, film, text, meta FROM activity_events WHERE id > $1 ORDER BY id LIMIT $2', [afterId, READ_ROWS])
      : await pool!.query('SELECT id, at, kind, film, text, meta FROM (SELECT * FROM activity_events ORDER BY id DESC LIMIT $1) t ORDER BY id', [READ_ROWS]);
    const events = res.rows.map((r: any) => ({
      seq: Number(r.id), at: new Date(r.at).toISOString(), kind: r.kind, film: r.film, text: r.text, ...(r.meta ? { meta: r.meta } : {})
    }));
    return { events, last: events.length ? events[events.length - 1].seq : afterId, instance: 'db' };
  } catch (err) {
    Logger.error('Could not read the saved live activity', err);
    return null;
  }
}
