import axios from 'axios';
import { LRUCache } from 'lru-cache';
import { RawSubtitleItem, SubtitleQuery } from '../types/provider';
import { UserConfig } from '../types/config';
import { parseRelease, rankSubtitles, looksForced, looksMachineTranslated } from '../utils/scorer';
import { parseCues, fitOffset, decideAlignment, Cue, AlignmentDecision } from '../utils/timeline';
import { executeParallelSearch } from '../providers';
import { Logger } from '../utils/logger';
import { USER_AGENT } from '../config/version';

/**
 * Automatic re-timing ("subsync").
 *
 * Releases of the same episode can have a different start (a 2160p file with a few extra seconds, for instance),
 * so a subtitle made for a 1080p release is late or early by a constant amount. When none of the subtitles found
 * fits the playing file, a subtitle of the playing file's own kind (same resolution class, any language) is used as
 * a timing reference, and the subtitle that is served is shifted by the measured difference.
 */

export type ResolutionClass = 'uhd' | 'hd';

export function resolutionClass(resolution: number | null): ResolutionClass | null {
  if (resolution === null) return null;
  return resolution >= 2160 ? 'uhd' : 'hd';
}

export interface TriggerVerdict {
  needed: boolean;
  reason: string;
}

/**
 * Is a timing reference needed? Only when no subtitle in the list is "compatible" with the file
 * (same release group, or same resolution class) AND at least one subtitle is known to come from another class.
 * If nothing is known about the file (no name) or about the subtitles' classes, nothing changes.
 */
export function needsReference(filename: string | undefined | null, items: RawSubtitleItem[]): TriggerVerdict {
  if (!filename || !filename.trim()) return { needed: false, reason: 'the player sent no file name' };
  const video = parseRelease(filename);
  const videoClass = resolutionClass(video.resolution);
  if (!videoClass) return { needed: false, reason: 'the resolution of the file is unknown' };
  if (items.length === 0) return { needed: false, reason: 'no subtitles' };

  let knownOtherClass = 0;
  for (const item of items) {
    const sub = parseRelease(item.release || '');
    const sameGroup = Boolean(sub.group && video.group && sub.group === video.group);
    const subClass = resolutionClass(sub.resolution);
    if (sameGroup || subClass === videoClass) {
      return { needed: false, reason: sameGroup ? `a subtitle from the same group (${video.group})` : `a subtitle of the same resolution class (${videoClass})` };
    }
    if (subClass && subClass !== videoClass) knownOtherClass++;
  }
  if (knownOtherClass === 0) return { needed: false, reason: 'no subtitle is known to come from another resolution class' };
  return { needed: true, reason: `no subtitle of the same group or class (${videoClass}) among ${items.length}` };
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

export interface Reference {
  label: string;
  lang: string;
  provider: string;
  cues: Cue[];
}

const MIN_REFERENCE_CUES = 40;
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

/** Picks the references worth downloading: same resolution class as the file, best matching name first, any language */
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
    if (resolutionClass(parsed.resolution) !== videoClass) continue;
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
    const cues = parseCues(text);
    if (cues.length < MIN_REFERENCE_CUES) throw new Error('too few cues');
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
  const key = `${ctx.query.id}|${resolutionClass(video.resolution)}|${video.service || ''}|${video.group || ''}`;
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

// ---------------------------------------------------------------------------
// Aligning one subtitle
// ---------------------------------------------------------------------------

export interface AlignmentResult {
  decision: AlignmentDecision;
  references: Array<{ label: string; offset: number; score: number }>;
}

export function alignAgainst(candidateText: string, references: Reference[]): AlignmentResult {
  const cues = parseCues(candidateText);
  if (cues.length < MIN_REFERENCE_CUES || references.length === 0) {
    return {
      decision: { apply: false, offset: 0, confidence: 0, reason: references.length === 0 ? 'no reference found' : 'the subtitle has too few cues' },
      references: []
    };
  }
  const fits = references.map(r => ({ label: r.label, ...fitOffset(cues, r.cues, 60) }));
  return {
    decision: decideAlignment(fits.map(f => ({ offset: f.offset, score: f.score }))),
    references: fits.map(f => ({ label: f.label, offset: f.offset, score: f.score }))
  };
}

// ---------------------------------------------------------------------------
// What the Debug page shows: the latest decisions (in memory, per configuration)
// ---------------------------------------------------------------------------

export interface AlignmentLogEntry {
  at: string;
  id: string;
  filename: string;
  subtitle: string;
  outcome: 'shifted' | 'unchanged' | 'timeout' | 'error';
  offset: number;
  confidence: number;
  reason: string;
  references: Array<{ label: string; offset: number; score: number }>;
  ms: number;
}

const alignmentLog = new Map<string, AlignmentLogEntry[]>();

export function recordAlignment(configKey: string, entry: AlignmentLogEntry): void {
  const list = alignmentLog.get(configKey) || [];
  list.unshift(entry);
  if (list.length > 100) list.length = 100;
  alignmentLog.set(configKey, list);
}

export function getAlignments(configKey: string): AlignmentLogEntry[] {
  return alignmentLog.get(configKey) || [];
}
