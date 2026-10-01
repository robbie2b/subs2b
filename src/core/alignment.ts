import axios from 'axios';
import { LRUCache } from 'lru-cache';
import { RawSubtitleItem, SubtitleQuery } from '../types/provider';
import { UserConfig } from '../types/config';
import { parseRelease, rankSubtitles, looksForced, looksMachineTranslated, ParsedRelease, Source } from '../utils/scorer';
import { readCues } from '../utils/subtitleCues';
import { speechFlags, TimedCue } from '../utils/subsync';
import { MIN_REFERENCE_CUES, Reference } from './alignDecision';
import { executeParallelSearch } from '../providers';
import { Logger } from '../utils/logger';
import { USER_AGENT } from '../config/version';

/**
 * Automatic re-timing ("subsync").
 *
 * Releases of the same episode can have a different start (a 2160p file with a few extra seconds, for instance),
 * so a subtitle made for a 1080p release is late or early by a constant amount. Every subtitle not made by the playing
 * file's own group is checked against subtitles of the playing file's own kind (same resolution class and source family,
 * any language) used as timing references, and the subtitle that is served is shifted by the measured difference.
 */

export type ResolutionClass = 'uhd' | 'hd';

export function resolutionClass(resolution: number | null): ResolutionClass | null {
  if (resolution === null) return null;
  return resolution >= 2160 ? 'uhd' : 'hd';
}

/** Releases of one family come from the same master (a REMUX and a WEB-DL of one episode often start differently) */
export type SourceFamily = 'disc' | 'web' | 'tv' | 'dvd';

export function sourceFamily(source: Source | null): SourceFamily | null {
  switch (source) {
    case 'remux':
    case 'bluray':
      return 'disc';
    case 'webdl':
    case 'webrip':
      return 'web';
    case 'hdtv':
      return 'tv';
    case 'dvd':
      return 'dvd';
    default:
      return null;
  }
}

/**
 * Has a subtitle the same kind as the file: same resolution class AND same source family
 * (when the file's family is unknown, the class alone decides).
 */
function sameKind(sub: ParsedRelease, video: ParsedRelease): boolean {
  const videoFamily = sourceFamily(video.source);
  return resolutionClass(sub.resolution) === resolutionClass(video.resolution) &&
    (videoFamily === null || sourceFamily(sub.source) === videoFamily);
}

const kindLabel = (p: ParsedRelease): string =>
  [resolutionClass(p.resolution), sourceFamily(p.source)].filter(Boolean).join(' ');

export interface TriggerVerdict {
  needed: boolean;
  reason: string;
}

/** Is the subtitle made by the playing file's own release group (the only label trusted without checking)? */
export function fromFileGroup(filename: string | undefined | null, release: string | undefined | null): boolean {
  if (!filename) return false;
  const video = parseRelease(filename);
  const sub = parseRelease(release || '');
  return Boolean(sub.group && video.group && sub.group === video.group);
}

/**
 * Is a timing reference needed? Whenever a subtitle in the list is not from the file's own release group.
 * The kind written in a subtitle's name is not trusted: a subtitle labelled "1080p BluRay" can be made for a
 * sped-up (x1.043) or a differently cut release (The Chaser), so it is checked against the references; one that
 * already lines up is served unchanged ("already aligned"). Subtitles from the file's own group are not checked.
 * If nothing is known about the file (no name, no resolution), nothing changes.
 */
export function needsReference(filename: string | undefined | null, items: RawSubtitleItem[]): TriggerVerdict {
  if (!filename || !filename.trim()) return { needed: false, reason: 'the player sent no file name' };
  const video = parseRelease(filename);
  const videoClass = resolutionClass(video.resolution);
  if (!videoClass) return { needed: false, reason: 'the resolution of the file is unknown' };
  if (items.length === 0) return { needed: false, reason: 'no subtitles' };

  const unchecked = items.filter(item => !fromFileGroup(filename, item.release)).length;
  if (unchecked === 0) return { needed: false, reason: `all subtitles are from the same group (${video.group})` };
  const own = items.length - unchecked;
  return {
    needed: true,
    reason: `${unchecked} of ${items.length} subtitle(s) not from the file's group are checked against references (${kindLabel(video)})` +
      (own ? `; ${own} from the same group (${video.group}) are served as they are` : '')
  };
}

/** Season/episode/file-name parameters that let an archive download choose the right file inside a season pack */
export function archivePickParams(query: SubtitleQuery): string {
  return (query.season != null ? `&season=${query.season}` : '') +
    (query.episode != null ? `&episode=${query.episode}` : '') +
    (query.extra?.filename ? `&vf=${encodeURIComponent(query.extra.filename)}` : '');
}

// ---------------------------------------------------------------------------
// Finding references
// ---------------------------------------------------------------------------

export type { Reference } from './alignDecision';

const MAX_REFERENCES = 3;
const REFERENCE_DOWNLOAD_TIMEOUT_MS = 8000;

const referenceCache = new LRUCache<string, Promise<Reference[]>>({ max: 300, ttl: 6 * 60 * 60 * 1000 });

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const res = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    timeout: timeoutMs,
    maxContentLength: 10 * 1024 * 1024,
    headers: { 'User-Agent': USER_AGENT, Accept: '*/*' }
  });
  return Buffer.from(res.data).toString('utf8');
}

/** Picks the references worth downloading: same kind as the file (class and family), best matching name first, any language */
export function pickReferenceCandidates(
  items: RawSubtitleItem[],
  filename: string,
  season: number | null,
  episode: number | null,
  limit = MAX_REFERENCES + 2
): RawSubtitleItem[] {
  const video = parseRelease(filename);
  const videoClass = resolutionClass(video.resolution);
  if (!videoClass || items.length === 0) return [];

  const ranked = rankSubtitles(items, { filename, season, episode });
  if (ranked.fallback) return [];

  const chosen: RawSubtitleItem[] = [];
  const seen = new Set<string>();
  for (const item of ranked.items) {
    const release = item.release || '';
    const parsed = parseRelease(release);
    if (!sameKind(parsed, video)) continue;
    if (parsed.badQuality || looksForced(release) || looksMachineTranslated(release)) continue;
    if (item.forced || item.aiTranslated) continue;
    const key = `${item.provider}|${item.lang}|${release.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chosen.push(item);
    if (chosen.length >= limit) break;
  }
  return chosen;
}

export interface ReferenceContext {
  query: SubtitleQuery;
  config: UserConfig;
  /** public address of this server, to fetch the subtitles that providers link through it */
  baseUrl: string;
  filename: string;
}

function absoluteUrl(item: RawSubtitleItem, ctx: ReferenceContext): string {
  if (item.url.startsWith('/')) {
    return `${ctx.baseUrl}${item.url}${item.url.startsWith('/sub/proxy?') ? archivePickParams(ctx.query) : ''}`;
  }
  return item.url;
}

async function buildReferences(ctx: ReferenceContext): Promise<Reference[]> {
  const started = Date.now();
  // Only the built-in services take part (they can search in every language); addons and RegieLive are Romanian-only or fixed
  const referenceConfig: UserConfig = {
    ...ctx.config,
    customAddons: [],
    providers: { ...ctx.config.providers, regielive: { enabled: false, apiKey: '' } }
  };
  const raw = await executeParallelSearch({ ...ctx.query, allLanguages: true }, referenceConfig);
  const candidates = pickReferenceCandidates(raw, ctx.filename, ctx.query.season, ctx.query.episode);
  if (candidates.length === 0) {
    Logger.info(`[SUBSYNC] no reference candidates for ${ctx.query.id} (${raw.length} subtitles searched)`);
    return [];
  }

  const downloads = await Promise.allSettled(candidates.map(async item => {
    const text = await fetchText(absoluteUrl(item, ctx), REFERENCE_DOWNLOAD_TIMEOUT_MS);
    const read = readCues(text);
    if (read.length < MIN_REFERENCE_CUES) throw new Error('too few cues');
    const flags = speechFlags(read);
    const cues: TimedCue[] = read.map((c, i) => ({ start: c.start, end: c.end, speech: flags[i] }));
    return { label: `[${item.lang}] ${item.release || item.id}`, lang: item.lang, provider: item.provider, cues } as Reference;
  }));

  const references = downloads
    .filter((d): d is PromiseFulfilledResult<Reference> => d.status === 'fulfilled')
    .map(d => d.value)
    .slice(0, MAX_REFERENCES);
  Logger.info(`[SUBSYNC] ${references.length} reference(s) for ${ctx.query.id} in ${Date.now() - started} ms`, {
    references: references.map(r => r.label)
  });
  return references;
}

/** References for one episode/file kind (cached, and shared by concurrent requests) */
export function getReferences(ctx: ReferenceContext): Promise<Reference[]> {
  const video = parseRelease(ctx.filename);
  const key = `${ctx.query.id}|${resolutionClass(video.resolution)}|${sourceFamily(video.source) || ''}|${video.service || ''}|${video.group || ''}`;
  let pending = referenceCache.get(key);
  if (!pending) {
    pending = buildReferences(ctx).then(refs => {
      // "nothing found" is remembered for a shorter time, so a later try can succeed
      if (refs.length === 0) referenceCache.set(key, pending!, { ttl: 15 * 60 * 1000 });
      return refs;
    });
    referenceCache.set(key, pending);
    pending.catch(() => referenceCache.delete(key));
  }
  return pending;
}

export function clearReferenceCache(): void {
  referenceCache.clear();
}

// Aligning one subtitle: pure computation, in its own module so a worker thread can load it alone
export { alignAgainst, fitsReferences, referencesAgree, MIN_REFERENCE_CUES } from './alignDecision';
export type { AlignmentResult } from './alignDecision';

// What the Debug page shows (kept in the database when there is one): see storage/alignmentLogStore.ts
export { recordAlignment, getAlignments } from '../storage/alignmentLogStore';
export type { AlignmentLogEntry } from '../storage/alignmentLogStore';
