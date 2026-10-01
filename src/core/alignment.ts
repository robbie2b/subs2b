import axios from 'axios';
import { LRUCache } from 'lru-cache';
import { RawSubtitleItem, SubtitleQuery } from '../types/provider';
import { UserConfig } from '../types/config';
import { parseRelease, rankSubtitles, looksForced, looksMachineTranslated, ParsedRelease, Source } from '../utils/scorer';
import { readCues } from '../utils/subtitleCues';
import { speechFlags, TimedCue } from '../utils/subsync';
import { MIN_REFERENCE_CUES, Reference } from './alignDecision';
import { executeParallelSearch } from '../providers';
import { loadStoredReferences, storeReferences } from '../storage/referenceStore';
import { serverCanDownload } from '../proxy/subtitleProxy';
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

/**
 * The cut of the film named in a release (extended, director's cut...): another cut has scenes more or less, so
 * another timeline. "Theatrical" is the usual cut, the same as none. (IMAX and remastered keep the cut.)
 */
const CUTS = new Set(['extended', 'unrated', 'directors', 'uncut', 'finalcut', 'special']);
export function cutOf(p: ParsedRelease): string {
  return p.edition.filter(e => CUTS.has(e)).sort().join(',');
}

const kindLabel = (p: ParsedRelease): string =>
  [resolutionClass(p.resolution), sourceFamily(p.source)].filter(Boolean).join(' ');

export interface TriggerVerdict {
  needed: boolean;
  reason: string;
}

/**
 * Is the subtitle made by the playing file's own release group, for the same cut of the film (the only label
 * trusted without checking)?
 */
export function fromFileGroup(filename: string | undefined | null, release: string | undefined | null): boolean {
  if (!filename) return false;
  const video = parseRelease(filename);
  const sub = parseRelease(release || '');
  return Boolean(sub.group && video.group && sub.group === video.group) && cutOf(sub) === cutOf(video);
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

/**
 * Picks the references worth downloading: same kind as the file (class and family), best matching name first, any
 * language. At equal score a reference from another service goes before OpenSubtitles, whose daily download quota is
 * kept for the subtitles the user picks.
 */
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

  const quota = (item: RawSubtitleItem) => (item.provider === 'opensubtitles' ? 1 : 0);
  const order = ranked.items
    .map((item, i) => ({ item, i, score: ranked.details[i]?.score ?? 0 }))
    .sort((a, b) => b.score - a.score || quota(a.item) - quota(b.item) || a.i - b.i);

  const chosen: RawSubtitleItem[] = [];
  const seen = new Set<string>();
  for (const { item } of order) {
    const release = item.release || '';
    const parsed = parseRelease(release);
    if (!sameKind(parsed, video)) continue;
    // another cut of the film has another timeline
    if (cutOf(parsed) !== cutOf(video)) continue;
    // a source refusing this server for now (a quota reached...) would only waste time
    if (!serverCanDownload(item)) continue;
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
    // an OpenSubtitles reference is taken from the download mirrors first: the API quota is kept for the user's picks
    const extra = item.url.startsWith('/sub/proxy?') ? archivePickParams(ctx.query)
      : item.url.startsWith('/proxy/download/os-rest/') ? '&mirrorFirst=1' : '';
    return `${ctx.baseUrl}${item.url}${extra}`;
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

  const load = async (item: RawSubtitleItem): Promise<Reference> => {
    const text = await fetchText(absoluteUrl(item, ctx), REFERENCE_DOWNLOAD_TIMEOUT_MS);
    const read = readCues(text);
    if (read.length < MIN_REFERENCE_CUES) throw new Error('too few cues');
    const flags = speechFlags(read);
    const cues: TimedCue[] = read.map((c, i) => ({ start: c.start, end: c.end, speech: flags[i] }));
    return { label: `[${item.lang}] ${item.release || item.id}`, lang: item.lang, provider: item.provider, cues } as Reference;
  };

  // Only as many downloads as references are needed (in parallel); the next candidates only replace failed ones
  const found: Array<{ at: number; ref: Reference }> = [];
  const failures: string[] = [];
  let next = 0;
  while (found.length < MAX_REFERENCES && next < candidates.length) {
    const wave = candidates.slice(next, next + MAX_REFERENCES - found.length).map((item, k) => ({ item, at: next + k }));
    next += wave.length;
    const results = await Promise.allSettled(wave.map(w => load(w.item)));
    results.forEach((r, k) => {
      if (r.status === 'fulfilled') found.push({ at: wave[k].at, ref: r.value });
      else failures.push(`[${wave[k].item.provider}] ${wave[k].item.release || wave[k].item.id}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    });
  }
  if (failures.length) Logger.info(`[SUBSYNC] ${failures.length} reference download(s) failed for ${ctx.query.id}`, { failures });
  const references = found.sort((a, b) => a.at - b.at).map(f => f.ref);
  Logger.info(`[SUBSYNC] ${references.length} reference(s) for ${ctx.query.id} in ${Date.now() - started} ms`, {
    references: references.map(r => r.label)
  });
  return references;
}

/** What the references depend on: the content and the kind of file (class, source, service, group, cut) */
export function referenceKey(id: string, filename: string): string {
  const video = parseRelease(filename);
  return `${id}|${resolutionClass(video.resolution)}|${sourceFamily(video.source) || ''}|${video.service || ''}|${video.group || ''}|${cutOf(video)}`;
}

/**
 * References for one episode/file kind: from memory, else from the database (kept once found, so they are never
 * downloaded twice), else searched and downloaded. Shared by concurrent requests.
 */
export function getReferences(ctx: ReferenceContext): Promise<Reference[]> {
  const key = referenceKey(ctx.query.id, ctx.filename);
  let pending = referenceCache.get(key);
  if (!pending) {
    pending = loadStoredReferences(key).then(stored => {
      if (stored && stored.length) {
        Logger.info(`[SUBSYNC] ${stored.length} stored reference(s) for ${ctx.query.id} (nothing downloaded)`, { references: stored.map(r => r.label) });
        return stored;
      }
      return buildReferences(ctx).then(refs => { storeReferences(key, refs); return refs; });
    }).then(refs => {
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
