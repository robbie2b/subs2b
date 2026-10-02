import type { Pool } from 'pg';

/**
 * Small helpers that keep the database from stalling the server.
 *
 * A table is created on first use. "CREATE TABLE IF NOT EXISTS" waits, with no end, behind any session holding a lock
 * on the same name (1.4.7/1.4.8: the source_blocks table never got created and the query hung for hours). So the
 * table is looked up first (a catalog read that nothing blocks), and created only when missing, giving up after 5 s
 * of waiting for a lock: the error says so instead of hanging.
 */

const LOCK_WAIT = '5s';

/** Does the table exist (committed)? */
export async function tableExists(pool: Pool, table: string): Promise<boolean> {
  const res = await pool.query('SELECT to_regclass($1) IS NOT NULL AS ok', [`public.${table}`]);
  return res.rows[0]?.ok === true;
}

/** Creates a table (and its indexes) unless it exists; never waits more than 5 s for a lock */
export async function ensureTableSafely(pool: Pool, table: string, ddl: string): Promise<void> {
  if (await tableExists(pool, table)) return;
  const client = await pool.connect();
  try {
    await client.query(`BEGIN; SET LOCAL lock_timeout = '${LOCK_WAIT}'; ${ddl}; COMMIT;`);
    client.release();
  } catch (err) {
    // the connection is left inside the failed transaction (or still busy, after a query timeout): it is closed,
    // not given back, and the database rolls back what was started
    client.release(err instanceof Error ? err : true);
    throw err;
  }
}

/** What the database is doing now: sessions of this database that are not idle, and who waits for whom */
export async function databaseActivity(pool: Pool): Promise<unknown> {
  const sessions = await pool.query(`
    SELECT pid, state, wait_event_type, wait_event,
           round(extract(epoch FROM now() - xact_start))::int AS transaction_seconds,
           round(extract(epoch FROM now() - query_start))::int AS query_seconds,
           pg_blocking_pids(pid) AS blocked_by,
           application_name, left(query, 300) AS query
    FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid() AND state IS DISTINCT FROM 'idle'
    ORDER BY xact_start NULLS LAST
    LIMIT 50`);
  const tables = await pool.query(`
    SELECT t AS table, to_regclass('public.' || t) IS NOT NULL AS exists
    FROM unnest(ARRAY['configurations', 'usage_events', 'subsync_decisions', 'subsync_references', 'source_blocks']) AS t`);
  return {
    pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
    tables: tables.rows,
    sessions: sessions.rows
  };
}
