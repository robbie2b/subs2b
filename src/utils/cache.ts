import { LRUCache } from 'lru-cache';
import { RawSubtitleItem } from '../types/provider';

export class SubtitleCache {
  private cache: LRUCache<string, RawSubtitleItem[]>;

  constructor(defaultTtlMinutes = 30, maxEntries = 500) {
    this.cache = new LRUCache<string, RawSubtitleItem[]>({
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
    return this.cache.get(key);
  }

  set(key: string, subtitles: RawSubtitleItem[], ttlMinutes?: number): void {
    this.cache.set(key, subtitles, { ttl: (ttlMinutes || 30) * 60 * 1000 });
  }

  get size(): number {
    return this.cache.size;
  }
}

export const globalSubtitleCache = new SubtitleCache(30, 1000);
