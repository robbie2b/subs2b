import { LRUCache } from 'lru-cache';
import { RawSubtitleItem } from '../types/provider';

interface CacheEntry {
  items: RawSubtitleItem[];
  /** a provider failed or timed out during the search: the list may lack subtitles */
  incomplete: boolean;
}

export class SubtitleCache {
  private cache: LRUCache<string, CacheEntry>;

  constructor(defaultTtlMinutes = 30, maxEntries = 500) {
    this.cache = new LRUCache<string, CacheEntry>({
      max: maxEntries,
      ttl: defaultTtlMinutes * 60 * 1000
    });
  }

  generateKey(
    id: string,
    languages: string[],
    providers: string[],
    season?: number | null,
    episode?: number | null
  ): string {
    const sortedLangs = [...languages].sort().join(',');
    const sortedProviders = [...providers].sort().join(',');
    const epStr = season !== null && episode !== null ? `s${season}e${episode}` : '';
    return `${id}:${epStr}:${sortedLangs}:${sortedProviders}`;
  }

  get(key: string): RawSubtitleItem[] | undefined {
    return this.cache.get(key)?.items;
  }

  /** whether the stored search had a provider failing (see set) */
  isIncomplete(key: string): boolean {
    return this.cache.get(key)?.incomplete === true;
  }

  /** `ttlMinutes` may be fractional (an incomplete search is kept only briefly) */
  set(key: string, subtitles: RawSubtitleItem[], ttlMinutes?: number, incomplete = false): void {
    this.cache.set(key, { items: subtitles, incomplete }, { ttl: Math.round((ttlMinutes || 30) * 60 * 1000) });
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

export const globalSubtitleCache = new SubtitleCache(30, 1000);
