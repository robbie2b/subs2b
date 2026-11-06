import zlib from 'zlib';
import { configStorage } from './configStore';
import { ensureTableSafely } from './dbTools';
import { Logger } from '../utils/logger';
import { keepAlive } from '../utils/background';

/**
 * What was fetched from the Subs.ro API, kept so that the daily limit (300 requests) is spent once and not again: the
 * search results of a title (6 hours) and the archives ("packs") they point to, with the list of subtitle files inside
 * (until the pack changes on the site). Shared by every server instance through PostgreSQL; this instance's memory is
 * the first stop. Without a database only the memory is used.
 */

const SEARCH_TTL_MS = 6 * 60 * 60 * 1000;
const PACK_KEEP_DAYS = 14;
const MEMORY_BYTES = 48 * 1024 * 1024;

export interface SubsroPack {
  /** the pack's `updatedAt` on the site when it was downloaded: a newer one means it has to be fetched again */
  version: string;
  entries: string[];
  archive: Buffer;
}

let tableReady: Promise<boolean> | null = null;
function ensureTable(): Promise<boolean> {
  if (!tableReady) {
    tableReady = (async () => {
      const pool = await configStorage.getPool();
      if (!pool) return false;
      await ensureTableSafely(pool, 'subsro_cache', `
        CREATE TABLE IF NOT EXISTS subsro_cache (
          key TEXT PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          meta JSONB,
          data BYTEA NOT NULL
        );
        CREATE INDEX IF NOT EXISTS subsro_cache_created ON subsro_cache (created_at)`);
      return true;
    })().catch(err => {
      Logger.error('Could not prepare the Subs.ro cache table, trying again in 30 s', err);
      setTimeout(() => { tableReady = null; }, 30000).unref();
      return false;
    });
  }
  return tableReady;
}

// --- memory (oldest out first, by size) ---
const searchMemory = new Map<string, { at: number; items: unknown[] }>();
const packMemory = new Map<string, SubsroPack>();
let packBytes = 0;

function rememberPack(id: string, pack: SubsroPack): void {
  const old = packMemory.get(id);
  if (old) { packBytes -= old.archive.length; packMemory.delete(id); }
  packMemory.set(id, pack);
  packBytes += pack.archive.length;
  while (packBytes > MEMORY_BYTES && packMemory.size > 1) {
    const first = packMemory.keys().next().value as string;
    packBytes -= packMemory.get(first)!.archive.length;
    packMemory.delete(first);
  }
}

// --- search results ---
export async function getSearch(imdbId: string): Promise<unknown[] | null> {
  const mem = searchMemory.get(imdbId);
  if (mem && Date.now() - mem.at < SEARCH_TTL_MS) return mem.items;
  try {
    if (!(await ensureTable())) return null;
    const pool = await configStorage.getPool();
    const res = await pool!.query(
      `SELECT data FROM subsro_cache WHERE key = $1 AND created_at > NOW() - INTERVAL '${SEARCH_TTL_MS / 1000} seconds'`, [`search|${imdbId}`]);
    if (!res.rows.length) return null;
    const items = JSON.parse(zlib.gunzipSync(res.rows[0].data as Buffer).toString('utf8')) as unknown[];
    searchMemory.set(imdbId, { at: Date.now(), items });
    return items;
  } catch (err) {
    Logger.error('Could not read the Subs.ro search cache', err);
    return null;
  }
}

export function setSearch(imdbId: string, items: unknown[]): void {
  searchMemory.set(imdbId, { at: Date.now(), items });
  keepAlive((async () => {
    try {
      if (!(await ensureTable())) return;
      const pool = await configStorage.getPool();
      await pool!.query(
        `INSERT INTO subsro_cache (key, data) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, created_at = NOW()`,
        [`search|${imdbId}`, zlib.gzipSync(Buffer.from(JSON.stringify(items)))]);
    } catch (err) {
      Logger.error('Could not save the Subs.ro search', err);
    }
  })());
}

// --- packs ---
export async function getPack(id: string): Promise<SubsroPack | null> {
  const mem = packMemory.get(id);
  if (mem) return mem;
  try {
    if (!(await ensureTable())) return null;
    const pool = await configStorage.getPool();
    const res = await pool!.query(`SELECT meta, data FROM subsro_cache WHERE key = $1`, [`pack|${id}`]);
    if (!res.rows.length) return null;
    const pack: SubsroPack = {
      version: String(res.rows[0].meta?.version || ''),
      entries: Array.isArray(res.rows[0].meta?.entries) ? res.rows[0].meta.entries : [],
      archive: zlib.gunzipSync(res.rows[0].data as Buffer)
    };
    rememberPack(id, pack);
    return pack;
  } catch (err) {
    Logger.error('Could not read a Subs.ro pack', err);
    return null;
  }
}

export function setPack(id: string, pack: SubsroPack): void {
  rememberPack(id, pack);
  keepAlive((async () => {
    try {
      if (!(await ensureTable())) return;
      const pool = await configStorage.getPool();
      await pool!.query(
        `INSERT INTO subsro_cache (key, meta, data) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET meta = EXCLUDED.meta, data = EXCLUDED.data, created_at = NOW()`,
        [`pack|${id}`, JSON.stringify({ version: pack.version, entries: pack.entries }), zlib.gzipSync(pack.archive)]);
      if (Math.random() < 0.05) {
        await pool!.query(`DELETE FROM subsro_cache WHERE key LIKE 'pack|%' AND created_at < NOW() - INTERVAL '${PACK_KEEP_DAYS} days'`);
        await pool!.query(`DELETE FROM subsro_cache WHERE key LIKE 'search|%' AND created_at < NOW() - INTERVAL '2 days'`);
      }
    } catch (err) {
      Logger.error('Could not save a Subs.ro pack', err);
    }
  })());
}

/** For tests */
export function clearSubsroMemory(): void {
  searchMemory.clear();
  packMemory.clear();
  packBytes = 0;
}
