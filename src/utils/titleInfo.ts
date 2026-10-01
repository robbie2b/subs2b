import axios from 'axios';
import { LRUCache } from 'lru-cache';
import { SubtitleQuery } from '../types/provider';
import { Logger } from './logger';
import { USER_AGENT } from '../config/version';

/** Name and year of a film or series (from Stremio's Cinemeta), for the providers that search by title */
export interface TitleInfo {
  name: string;
  year: number | null;
}

const titleCache = new LRUCache<string, TitleInfo>({ max: 500, ttl: 24 * 60 * 60 * 1000 });

export async function titleInfoOf(query: SubtitleQuery, signal: AbortSignal | undefined, who: string): Promise<TitleInfo | null> {
  if (!query.imdbId) return null;
  const cacheKey = `${query.type}:${query.imdbId}`;
  const cached = titleCache.get(cacheKey);
  if (cached) return cached;
  try {
    const kind = query.type === 'movie' ? 'movie' : 'series';
    const res = await axios.get<{ meta?: { name?: string; year?: string | number; releaseInfo?: string } }>(
      `https://v3-cinemeta.strem.io/meta/${kind}/${query.imdbId}.json`,
      { timeout: 5000, signal, headers: { 'User-Agent': USER_AGENT } }
    );
    const meta = res.data?.meta;
    if (!meta?.name) return null;
    const yearMatch = String(meta.year || meta.releaseInfo || '').match(/(19|20)\d{2}/);
    const info: TitleInfo = { name: meta.name, year: yearMatch ? parseInt(yearMatch[0], 10) : null };
    titleCache.set(cacheKey, info);
    return info;
  } catch (err) {
    Logger.warn(`${who}: could not get the title of ${query.imdbId} from Cinemeta`, { reason: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Words of a title, without accents and small words ("The Office" -> office) */
export function titleTokens(text: string): string[] {
  return text
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter(t => t && !['the', 'a', 'an', 'of', 'and'].includes(t));
}

/** Share of words two titles have in common (0..1) */
export function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  sa.forEach(t => { if (sb.has(t)) inter++; });
  return inter / (sa.size + sb.size - inter);
}
