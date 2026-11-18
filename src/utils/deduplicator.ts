import { RawSubtitleItem } from '../types/provider';

/**
 * Tokenizes release names to calculate fuzzy similarity. The same names come back on every request and in several
 * passes (deduplication, backups), so the token sets are remembered (they are never changed by the callers).
 */
const TOKEN_CACHE_MAX = 4000;
const tokenCache = new Map<string, Set<string>>();
function tokenize(str: string): Set<string> {
  const hit = tokenCache.get(str);
  if (hit) return hit;
  const tokens = new Set(
    str
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1)
  );
  if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.clear();
  tokenCache.set(str, tokens);
  return tokens;
}

/**
 * Calculates Dice's token similarity coefficient (0 to 1)
 */
function similarity(tokensA: Set<string>, tokensB: Set<string>): number {
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) {
      intersection++;
    }
  }
  return (2 * intersection) / (tokensA.size + tokensB.size);
}

/**
 * What tells two releases apart even when their names are almost the same word for word (Dice counts "S02E05" and
 * "S02E06" as one different token out of many): season/episode, year, resolution and the group at the end. Two names that
 * both state one of these and differ are different subtitles, whatever the rest of the name says.
 */
function identityOf(release: string): { se: string | null; year: string | null; res: string | null; group: string | null } {
  const r = release.toLowerCase();
  const se = r.match(/\bs(\d{1,2})e(\d{1,3})\b/) || r.match(/\b(\d{1,2})x(\d{2,3})\b(?!\d)/);
  const year = r.match(/(?<![0-9])(19\d{2}|20\d{2})(?![0-9])/);
  const res = r.match(/\b(2160|1080|720|576|480)p\b/);
  const group = r.replace(/\.(srt|vtt|ass|mkv|mp4|avi)$/, '').replace(/-rum(\(\d+\))?$/, '').match(/-([a-z0-9]{2,15})$/);
  return { se: se ? `${parseInt(se[1], 10)}x${parseInt(se[2], 10)}` : null, year: year ? year[1] : null, res: res ? res[1] : null, group: group ? group[1] : null };
}
const identityCache = new Map<string, ReturnType<typeof identityOf>>();
function identity(release: string): ReturnType<typeof identityOf> {
  let v = identityCache.get(release);
  if (!v) {
    if (identityCache.size >= TOKEN_CACHE_MAX) identityCache.clear();
    v = identityOf(release);
    identityCache.set(release, v);
  }
  return v;
}
function sameIdentity(a: string, b: string): boolean {
  const x = identity(a), y = identity(b);
  return !((x.se && y.se && x.se !== y.se) || (x.year && y.year && x.year !== y.year) ||
    (x.res && y.res && x.res !== y.res) || (x.group && y.group && x.group !== y.group));
}

const bucketKey = (i: RawSubtitleItem): string => `${i.lang}|${i.hearingImpaired ? 1 : 0}`;

/**
 * Deduplicates a list of subtitles based on:
 * 1. Identical download URL
 * 2. Identical language + identical hearing-impaired status + high fuzzy similarity (>0.85) on release name
 *
 * Items earlier in the array take precedence over later items. A dropped duplicate with another link is kept as a
 * download backup of the item it duplicates (`backups`, in order); the input items are not changed.
 */
export function deduplicateSubtitles(
  items: RawSubtitleItem[],
  similarityThreshold = 0.85,
  strategy: 'both' | 'hash' | 'fuzzy' = 'both'
): RawSubtitleItem[] {
  const result: RawSubtitleItem[] = [];
  const seenUrls = new Set<string>();
  // the kept items by language and hearing-impaired status (a duplicate must have both equal), in order
  const buckets = new Map<string, RawSubtitleItem[]>();

  const checkHash = strategy === 'both' || strategy === 'hash';
  const checkFuzzy = strategy === 'both' || strategy === 'fuzzy';

  for (const item of items) {
    // 1. Identical download URL
    if (checkHash && item.url && seenUrls.has(item.url)) {
      continue;
    }

    // 2. Fuzzy release name similarity deduplication
    let isDuplicate = false;
    let original: RawSubtitleItem | null = null;
    if (checkFuzzy) {
      const itemTokens = item.release ? tokenize(item.release) : new Set<string>();

      if (itemTokens.size > 0) {
        for (const existing of buckets.get(bucketKey(item)) || []) {
          if (existing.release) {
            const existingTokens = tokenize(existing.release);
            const score = similarity(itemTokens, existingTokens);
            if (score >= similarityThreshold && sameIdentity(item.release!, existing.release)) {
              isDuplicate = true;
              original = existing;
              break;
            }
          }
        }
      }
    }

    if (!isDuplicate) {
      if (item.url) seenUrls.add(item.url);
      const kept = { ...item, backups: [] as RawSubtitleItem[] };
      result.push(kept);
      const key = bucketKey(kept);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(kept); else buckets.set(key, [kept]);
    } else if (original && item.url && !seenUrls.has(item.url)) {
      seenUrls.add(item.url);
      original.backups!.push(item);
    }
  }

  return result.map(r => (r.backups!.length ? r : (({ backups: _b, ...rest }) => rest)(r)));
}

/**
 * The copies of one subtitle among other items (same language and hearing-impaired status, a very similar release
 * name, another link), in order: download backups for an item that deduplication leaves alone (an exact hash match).
 */
export function copiesOf(item: RawSubtitleItem, others: RawSubtitleItem[], similarityThreshold = 0.85): RawSubtitleItem[] {
  if (!item.release) return [];
  const tokens = tokenize(item.release);
  if (tokens.size === 0) return [];
  return others.filter(o => o !== item && o.url && o.url !== item.url && o.lang === item.lang &&
    Boolean(o.hearingImpaired) === Boolean(item.hearingImpaired) && o.release &&
    similarity(tokens, tokenize(o.release)) >= similarityThreshold && sameIdentity(item.release!, o.release));
}

/**
 * Sorts subtitles by provider priority defined by the user
 */
export function prioritizeSubtitles(
  items: RawSubtitleItem[],
  providerPriority: string[]
): RawSubtitleItem[] {
  if (!providerPriority || providerPriority.length === 0) {
    return items;
  }

  const priorityMap = new Map<string, number>();
  providerPriority.forEach((id, index) => {
    priorityMap.set(id.toLowerCase(), index);
  });

  return [...items].sort((a, b) => {
    const priorityA = priorityMap.has(a.provider.toLowerCase())
      ? priorityMap.get(a.provider.toLowerCase())!
      : 999;
    const priorityB = priorityMap.has(b.provider.toLowerCase())
      ? priorityMap.get(b.provider.toLowerCase())!
      : 999;

    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }

    // Same provider priority: the more downloaded subtitle first
    const downloadsA = a.downloads || 0;
    const downloadsB = b.downloads || 0;
    return downloadsB - downloadsA;
  });
}
