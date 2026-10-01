import axios from 'axios';
import { LRUCache } from 'lru-cache';
import { RawSubtitleItem, SubtitleQuery } from '../types/provider';
import { UserConfig } from '../types/config';
import { parseRelease, rankSubtitles, looksForced, looksMachineTranslated } from '../utils/scorer';
import { readCues } from '../utils/subtitleCues';
import { alignToReference, decide, speechFlags, Decision, RefAlignment, TimedCue } from '../utils/subsync';
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
  /** times and whether each cue is dialogue (the text itself is not kept) */
  cues: TimedCue[];
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
  decision: Decision;
  references: Array<{ label: string; offset: number; score: number; ratio: number; segments: number }>;
}

const alignOne = (cues: TimedCue[], r: Reference, split: boolean, topRatios = 1): RefAlignment | null => {
  const result = alignToReference(cues, r.cues, { split, splitPenalty: 7, topRatios });
  return result ? { label: r.label, result } : null;
};

const medianOf = (a: number[]): number => {
  const s = a.slice().sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/**
 * Aligns a subtitle against the references. First with one single shift per reference (fast); only when that is not
 * convincing, with shifts that may change along the subtitle (and the frame-rate ratio).
 */
export function alignAgainst(candidateText: string, references: Reference[]): AlignmentResult {
  const cues = readCues(candidateText);
  if (cues.length < MIN_REFERENCE_CUES || references.length === 0) {
    return {
      decision: { apply: false, offset: 0, ratio: 1, segments: 0, confidence: 0, agreeing: 0, reason: references.length === 0 ? 'no reference found' : 'the subtitle has too few cues' },
      references: []
    };
  }

  // the references are taken one by one; once two of them agree (and fit well) the rest is not needed
  const collect = (split: boolean, topRatios: number): { list: RefAlignment[]; decision: Decision } => {
    const list: RefAlignment[] = [];
    let d = decide(cues, list);
    for (const r of references) {
      const a = alignOne(cues, r, split, topRatios);
      if (a) list.push(a);
      d = decide(cues, list);
      if (list.length >= 2 && d.agreeing >= 2 && d.confidence >= 0.9) break;
    }
    return { list, decision: d };
  };

  const first = collect(false, 1);
  let used = first.list;
  let decision = first.decision;

  // (when one shift already worked, the ratio is known: the split search tries only that one, which is much cheaper)
  if ((!decision.apply && decision.reason !== 'already aligned') || (decision.apply && decision.confidence < 0.95)) {
    const second = collect(true, decision.apply ? 1 : 2);
    if (second.decision.apply && (!decision.apply || second.decision.confidence >= decision.confidence)) {
      decision = second.decision;
      used = second.list;
    }
  }

  return {
    decision,
    references: used.map(a => ({
      label: a.label,
      offset: Math.round(medianOf(a.result.offsets) * 10) / 10,
      score: Math.round(a.result.overlap * 100) / 100,
      ratio: Math.round(a.result.ratio * 1000) / 1000,
      segments: a.result.segments.length
    }))
  };
}

// What the Debug page shows (kept in the database when there is one): see storage/alignmentLogStore.ts
export { recordAlignment, getAlignments } from '../storage/alignmentLogStore';
export type { AlignmentLogEntry } from '../storage/alignmentLogStore';
