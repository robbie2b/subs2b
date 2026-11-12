import axios from 'axios';
import { LRUCache } from 'lru-cache';
import { UserConfig } from '../types/config';
import { SubtitleQuery } from '../types/provider';
import { Logger } from '../utils/logger';
import { USER_AGENT } from '../config/version';
import { isBlocked, noteRefusal, statusOf } from '../utils/sourceHealth';
import { noteBrokenFile, isBrokenFileReason } from '../utils/brokenFiles';
import { noteDownloadFailure } from '../utils/downloadJournal';
import { AlignedToken, linksOf } from './alignedToken';
import { getReferences, refreshReferences, referencesCameFromStore, fitsReferences, AlignmentResult, Reference } from './alignment';
import { alignInWorker, referencesAgreeInWorker } from './alignPool';
import { activity, filmLabel, fmtMs } from '../utils/activity';
import { loadAligned, storeAligned } from '../storage/alignedStore';
import {
  addonHostsOf, isAllowedDownloadUrl, decompressBuffer, toCleanUtf8, validateAndFormatSubtitle, convertSubtitleFromUrl, convertTargetOf
} from '../proxy/subtitleProxy';

/**
 * Preparing an aligned subtitle: download it, find the references, decide. The work for one link is started once and
 * shared: by the list (it starts the likely choice while the player is still opening the video) and by the player's
 * requests for the subtitle (which then only wait for what is already under way).
 */

/** What is served for one link: the alignment, and the alternative's text when the first subtitle was replaced */
export interface Served {
  result: AlignmentResult;
  text?: string;
  replacedBy?: string;
  /** where the time went (ms): downloading the subtitle, finding the references, computing */
  timing?: { original: number; references: number; compute: number; ready: number };
}

export interface Prepared {
  /** the original subtitle as clean SRT */
  original: Promise<string>;
  /** the decision (after the original is loaded) */
  served: Promise<Served>;
  startedAt: number;
  /** the decision was already logged (the player asks for the same subtitle several times; it is computed once) */
  reported?: boolean;
}

const prepared = new LRUCache<string, Prepared>({ max: 200, ttl: 6 * 60 * 60 * 1000 });

export const preparedKey = (token: AlignedToken): string => `${token.u}|${token.f}`;

/** Downloads the original subtitle and returns it as clean SRT text */
export async function loadOriginal(url: string, allowedHosts: string[]): Promise<string> {
  const origin = new URL(url).origin;
  const upstream = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    timeout: 15000,
    maxContentLength: 10 * 1024 * 1024,
    maxRedirects: 3,
    beforeRedirect: (options: { href?: string }) => {
      // a redirect must stay on an allowed host (or on this server)
      const target = options.href || '';
      if (!isAllowedDownloadUrl(target, allowedHosts) && !target.startsWith(origin + '/')) {
        throw new Error('Redirect to a host that is not allowed');
      }
    },
    headers: { 'User-Agent': USER_AGENT, Accept: '*/*' }
  });
  const { buffer } = decompressBuffer(Buffer.from(upstream.data));
  const validation = validateAndFormatSubtitle(toCleanUtf8(buffer), 'srt');
  if (!validation.valid) {
    // (a link of this server's own proxy remembers it there, with the real address of the file)
    if (isBrokenFileReason(validation.reason) && !url.startsWith(origin + '/sub/proxy')) noteBrokenFile(url, validation.reason || '');
    throw new Error(validation.reason || 'invalid subtitle');
  }
  return validation.content;
}

const describe = (err: unknown): string => {
  const e = err as { response?: { status?: number }; message?: string };
  return e?.response?.status ? `HTTP ${e.response.status}` : (e?.message || String(err));
};

/**
 * Downloads the first of the links that works (the same subtitle from several providers, in priority order).
 * Only links of this server or of allowed hosts are tried. Every failure is logged, with the source that answered.
 */
export async function loadFirst(urls: string[], allowedHosts: string[], baseUrl: string, release?: string): Promise<{ text: string; url: string }> {
  const failures: string[] = [];
  for (const url of urls) {
    // A conversion link of this server (a .vtt of an addon) is not requested from ourselves over HTTP: the subtitle is
    // downloaded and converted right here, and the source that answers is the real one
    const converted = convertTargetOf(url, baseUrl);
    const fetchUrl = converted || url;
    const own = !converted && url.startsWith(baseUrl + '/');
    if (!own && !isAllowedDownloadUrl(fetchUrl, allowedHosts)) continue;
    const host = new URL(fetchUrl).hostname;
    const label = `${host}${new URL(fetchUrl).pathname.split('/').slice(0, 4).join('/')}`;
    if (!own && isBlocked(host)) {
      failures.push(`${label}: skipped (refusing this server for now)`);
      continue;
    }
    try {
      let text: string;
      if (converted) {
        try {
          text = await convertSubtitleFromUrl(converted, allowedHosts);
        } catch (err: unknown) {
          const reason = err instanceof Error ? err.message : String(err);
          if (isBrokenFileReason(reason)) noteBrokenFile(converted, reason);
          throw err;
        }
      } else {
        text = await loadOriginal(url, allowedHosts);
      }
      if (failures.length) {
        Logger.info(`[DOWNLOAD] served from a backup source (${host}) after: ${failures.join('; ')}`);
        noteDownloadFailure({ host: failures[0].split(':')[0].split('/')[0], place: 'backups', reason: `${failures.join('; ')} -> served by ${host}`, recovered: true, release });
      }
      return { text, url };
    } catch (err: unknown) {
      failures.push(`${label}: ${describe(err)}`);
      if (!own) noteRefusal(host, statusOf(err), describe(err));
    }
  }
  Logger.warn(`[DOWNLOAD] no source of the subtitle could be downloaded: ${failures.join('; ') || 'no allowed link'}`);
  noteDownloadFailure({ host: failures.length ? failures[0].split(':')[0].split('/')[0] : 'no allowed link', place: 'backups', reason: failures.join('; ') || 'no allowed link', recovered: false, release });
  throw new Error(failures.length ? `every source failed (${failures.join('; ')})` : 'no allowed link');
}

/** A subtitle ready to be aligned: the one asked for, or the next of its language when that one could not be downloaded */
export interface LoadedSubtitle {
  text: string;
  /** release name of the subtitle really loaded */
  release?: string;
  /** the subtitles after it, for the check against the references */
  alternatives: Array<{ u: string; r?: string; b?: string[] }>;
  /** set when the one asked for could not be downloaded and this one took its place */
  replacedBy?: string;
}

/**
 * Downloads the subtitle of a link. When no source of it can be downloaded (a file the site does not have any more,
 * an archive with nothing readable), the next subtitle of the same language takes its place, instead of the player
 * getting an error: a subtitle that works, one position lower, is better than none (Harry Potter: the first
 * subtitle's file was gone from Subtitrari-noi.ro, the second, of the same release, was fine).
 */
export async function loadWithAlternatives(token: AlignedToken, hosts: string[], baseUrl: string): Promise<LoadedSubtitle> {
  const alternatives = token.a || [];
  try {
    const first = await loadFirst(linksOf(token), hosts, baseUrl, token.r);
    return { text: first.text, release: token.r, alternatives };
  } catch (err: unknown) {
    for (let i = 0; i < alternatives.length; i++) {
      const alt = alternatives[i];
      if (!alt.u.startsWith(baseUrl + '/') && !isAllowedDownloadUrl(alt.u, hosts)) continue;
      try {
        const loaded = await loadFirst(linksOf(alt), hosts, baseUrl, alt.r);
        Logger.info(`[DOWNLOAD] the subtitle could not be downloaded, the next one of the same language is served instead: ${alt.r || alt.u}`);
        noteDownloadFailure({
          host: new URL(token.u).hostname, place: 'replaced', recovered: true, release: token.r,
          reason: `could not be downloaded (${describe(err)}); replaced by ${alt.r || alt.u}`
        });
        return { text: loaded.text, release: alt.r, alternatives: alternatives.slice(i + 1), replacedBy: alt.r || alt.u };
      } catch {
        // this one cannot be downloaded either: the next
      }
    }
    throw err;
  }
}

/**
 * Whether the references agree with each other depends only on the references (not on the subtitle checked), and
 * they are the same list for every subtitle of a film: it is worked out once (several pairwise alignments, seconds on
 * a slow CPU). The list is the one kept by the reference cache, so the same list object comes back.
 */
const agreement = new WeakMap<Reference[], Promise<boolean>>();
function referencesAgreeCached(refs: Reference[]): Promise<boolean> {
  let known = agreement.get(refs);
  if (!known) {
    known = referencesAgreeInWorker(refs);
    agreement.set(refs, known);
    // a failure is not kept
    known.catch(() => { if (agreement.get(refs) === known) agreement.delete(refs); });
  }
  return known;
}

/**
 * Aligns the subtitle; when it fits none of the references while the references agree with each other (so it was
 * clearly made for another release), the alternatives are tried in order and the first one that fits is served.
 */
async function alignOrReplace(
  text: string,
  release: string | undefined,
  file: string,
  refs: Reference[],
  alternatives: Array<{ u: string; r?: string; b?: string[] }>,
  hosts: string[],
  baseUrl: string
): Promise<Served> {
  const result = await alignInWorker(text, refs, release, file);
  if (fitsReferences(result) || result.references.length === 0 || alternatives.length === 0 || !(await referencesAgreeCached(refs))) {
    return { result };
  }
  for (const alt of alternatives) {
    if (!alt.u.startsWith(baseUrl + '/') && !isAllowedDownloadUrl(alt.u, hosts)) continue;
    try {
      const altText = (await loadFirst(linksOf(alt), hosts, baseUrl, alt.r)).text;
      const altResult = await alignInWorker(altText, refs, alt.r, file);
      if (fitsReferences(altResult)) {
        return { result: altResult, text: altText, replacedBy: alt.r || alt.u };
      }
    } catch (err: unknown) {
      Logger.warn('Subsync: an alternative could not be loaded', { reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { result };
}

/**
 * The preparation of one aligned link, started now or already under way. `query` is the content being played
 * (built from the token: id, type and file name). The caller checks that the link may be downloaded.
 */
/** Is a preparation for this link already under way (or done)? Does not start one. */
export function prepareAlignedPeek(token: AlignedToken): boolean {
  return prepared.has(preparedKey(token));
}

export function prepareAligned(token: AlignedToken, query: SubtitleQuery, config: UserConfig, baseUrl: string): Prepared {
  const key = preparedKey(token);
  const existing = prepared.get(key);
  if (existing) return existing;

  const hosts = addonHostsOf(config);
  const started = Date.now();
  // A result stored by any instance (same link, same file) is used as it is: nothing to download or compute. The
  // lookup is capped at 150 ms, so a slow database never holds the subtitle back.
  const work = loadAligned(key).then(hit => {
    if (hit) {
      const ms = Date.now() - started;
      const served = hit.served as Served;
      served.result.note = ['decided earlier (stored result)', served.result.note].filter(Boolean).join('; ');
      served.timing = { original: 0, references: 0, compute: 0, ready: ms };
      activity('sync', filmLabel(token.id, token.f), `"${(token.r || 'subtitle').slice(0, 70)}": decided earlier, read from storage in ${fmtMs(ms)} (nothing downloaded or computed)`, { step: 'compute', state: 'done', ms, verdict: 'stored' });
      return { original: Promise.resolve(hit.original), served: Promise.resolve(served) };
    }
    return compute();
  });
  const entry: Prepared = { original: work.then(w => w.original), served: work.then(w => w.served), startedAt: started };
  prepared.set(key, entry);
  // a failure is not kept: the next request tries again (and a preparation nobody waits for never throws)
  entry.original.catch(() => undefined);
  entry.served.catch((err: unknown) => {
    activity('warn', filmLabel(token.id, token.f), `Subsync failed for "${(token.r || 'subtitle').slice(0, 70)}": ${(err instanceof Error ? err.message : String(err)).slice(0, 100)}`, { step: 'compute', state: 'warn' });
    if (prepared.get(key) === entry) prepared.delete(key);
  });
  return entry;

  function compute(): { original: Promise<string>; served: Promise<Served> } {
  const timing = { original: 0, references: 0, compute: 0, ready: 0 };
  const film = filmLabel(token.id, token.f);
  const name = (token.r || 'subtitle').slice(0, 70);
  activity('sync', film, `Preparing "${name}": downloading it and getting the timing references`, { step: 'references', state: 'start' });
  // the subtitle and the references are fetched at the same time
  const loading = loadWithAlternatives(token, hosts, baseUrl).then(l => {
    timing.original = Date.now() - started;
    activity(l.replacedBy ? 'warn' : 'sync', film, l.replacedBy
      ? `"${name}" could not be downloaded: using the next one of the same language, "${String(l.replacedBy).slice(0, 60)}"`
      : `Subtitle downloaded in ${fmtMs(timing.original)}`);
    return l;
  });
  const original = loading.then(l => l.text);
  const references = getReferences({ query, config, baseUrl, filename: token.f })
    .then(refs => {
      timing.references = Date.now() - started;
      activity('sync', film, `${refs.length} timing reference${refs.length === 1 ? '' : 's'} ready after ${fmtMs(timing.references)}`, { step: 'references', state: 'done', ms: timing.references });
      return refs;
    });
  const served = Promise.all([loading, references]).then(async ([loaded, refs]) => {
    const computeStart = Date.now();
    let s = await alignOrReplace(loaded.text, loaded.release, token.f, refs, loaded.alternatives, hosts, baseUrl);
    // Stored references that fit nothing may be for another cut of the film: new ones are searched once and the
    // subtitle is checked again (Avatar: the stored ones said 0%, fresh ones 88-92%)
    if (!fitsReferences(s.result) && !s.replacedBy && /fits well enough|disagree|single reference/.test(s.result.decision.reason) && referencesCameFromStore(refs)) {
      activity('sync', film, 'The stored timing references fit nothing: searching new ones (once)');
      const fresh = await refreshReferences({ query, config, baseUrl, filename: token.f }).catch(() => null);
      if (fresh) {
        activity('sync', film, `${fresh.length} new timing reference${fresh.length === 1 ? '' : 's'} found: checking the subtitle again`);
        s = await alignOrReplace(loaded.text, loaded.release, token.f, fresh, loaded.alternatives, hosts, baseUrl);
        s.result.note = ['stored references fitted nothing: checked again with new ones', s.result.note].filter(Boolean).join('; ');
      }
    }
    timing.compute = Date.now() - computeStart;
    if (loaded.replacedBy && !s.replacedBy) {
      s.replacedBy = loaded.replacedBy;
      s.result.note = ['the subtitle could not be downloaded, the next one of the same language was used', s.result.note].filter(Boolean).join('; ');
    }
    // (all from the start of the preparation; `ready` = when the aligned subtitle could be served)
    timing.ready = Date.now() - started;
    const d = s.result.decision;
    activity('sync', film, `Decision for "${name}": ${d.apply ? `shifted ${d.offset > 0 ? '+' : ''}${d.offset} s${d.ratio !== 1 ? ` ×${d.ratio}` : ''}${d.segments > 1 ? ` in ${d.segments} parts` : ''}` : (d.reason === 'already aligned' ? 'unchanged (already aligned)' : `unchanged (${d.reason})`)} · confidence ${Math.round(d.confidence * 100)}% · computed in ${fmtMs(timing.compute)}`, { step: 'compute', state: 'done', ms: timing.compute, verdict: d.apply ? `shifted ${d.offset > 0 ? '+' : ''}${d.offset} s${d.ratio !== 1 ? ` ×${d.ratio}` : ''}` : `unchanged (${Math.round(d.confidence * 100)}%)` });
    const out = { ...s, timing };
    // a decision that is sure (shifted, or already aligned) is kept for the other instances and the next times;
    // "no reference" and "disagree" are not (they may change)
    if (fitsReferences(s.result)) {
      const { timing: _t, ...forStore } = out;
      storeAligned(key, { original: loaded.text, served: forStore });
    }
    return out;
  });
  return { original, served };
  }
}

export function clearPrepared(): void {
  prepared.clear();
}
