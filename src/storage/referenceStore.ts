import zlib from 'zlib';
import { configStorage } from './configStore';
import { Logger } from '../utils/logger';
import type { Reference } from '../core/alignDecision';

/**
 * Subsync references kept in PostgreSQL (when available): once found for an episode and a kind of file, they are
 * never downloaded again, not even after a restart (each download costs provider quota). Only the timing of the
 * lines is kept (when each line starts and ends, and whether it is dialogue), never the text. Shared by everyone:
 * the references belong to the content, not to a user.
 */

const RETENTION_DAYS = 60;
let tableReady: Promise<boolean> | null = null;

async function ensureTable(): Promise<boolean> {
  if (!tableReady) {
    tableReady = (async () => {
      const pool = await configStorage.getPool();
      if (!pool) return false;
      try {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS subsync_references (
            ref_key TEXT PRIMARY KEY,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            data BYTEA NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_subsync_references_created ON subsync_references(created_at);
        `);
        return true;
      } catch (err) {
        Logger.error('Could not prepare the Subsync references table', err);
        return false;
      }
    })();
  }
  return tableReady;
}

type StoredReference = { l: string; g: string; p: string; c: number[] };

/** Compact form: times in milliseconds (as in SRT), the dialogue flag as the sign of the duration */
export function packReferences(refs: Reference[]): Buffer {
  const list: StoredReference[] = refs.map(r => ({
    l: r.label, g: r.lang, p: r.provider,
    c: r.cues.flatMap(c => {
      const start = Math.round(c.start * 1000);
      const len = Math.max(1, Math.round((c.end - c.start) * 1000));
      return [start, c.speech === false ? -len : len];
    })
  }));
  return zlib.gzipSync(Buffer.from(JSON.stringify(list)));
}

export function unpackReferences(data: Buffer): Reference[] {
  const list = JSON.parse(zlib.gunzipSync(data).toString('utf8')) as StoredReference[];
  return list.map(r => {
    const cues = [];
    for (let i = 0; i + 1 < r.c.length; i += 2) {
      const start = r.c[i] / 1000;
      const len = r.c[i + 1];
      cues.push({ start, end: (r.c[i] + Math.abs(len)) / 1000, speech: len > 0 });
    }
    return { label: r.l, lang: r.g, provider: r.p, cues };
  });
}

/** The stored references, or null when there are none (or no database). Never throws. */
export async function loadStoredReferences(key: string): Promise<Reference[] | null> {
  try {
    if (!(await ensureTable())) return null;
    const pool = await configStorage.getPool();
    const res = await pool!.query(
      `SELECT data FROM subsync_references WHERE ref_key = $1 AND created_at > NOW() - INTERVAL '${RETENTION_DAYS} days'`,
      [key]
    );
    if (!res.rows.length) return null;
    return unpackReferences(res.rows[0].data as Buffer);
  } catch (err) {
    Logger.error('Could not read stored Subsync references', err);
    return null;
  }
}

/** Keeps the references (only a non-empty set). Never throws and never blocks the response. */
export function storeReferences(key: string, refs: Reference[]): void {
  if (refs.length === 0) return;
  void (async () => {
    try {
      if (!(await ensureTable())) return;
      const pool = await configStorage.getPool();
      await pool!.query(
        `INSERT INTO subsync_references (ref_key, data) VALUES ($1, $2)
         ON CONFLICT (ref_key) DO UPDATE SET data = EXCLUDED.data, created_at = NOW()`,
        [key, packReferences(refs)]
      );
      if (Math.random() < 0.02) {
        await pool!.query(`DELETE FROM subsync_references WHERE created_at < NOW() - INTERVAL '${RETENTION_DAYS} days'`);
      }
    } catch (err) {
      Logger.error('Could not store Subsync references', err);
    }
  })();
}
