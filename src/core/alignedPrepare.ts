import axios from 'axios';
import { LRUCache } from 'lru-cache';
import { UserConfig } from '../types/config';
import { SubtitleQuery } from '../types/provider';
import { Logger } from '../utils/logger';
import { USER_AGENT } from '../config/version';
import { isBlocked, noteRefusal, statusOf } from '../utils/sourceHealth';
import { AlignedToken, linksOf } from './alignedToken';
import { getReferences, fitsReferences, AlignmentResult, Reference } from './alignment';
import { alignInWorker, referencesAgreeInWorker } from './alignPool';
import {
  addonHostsOf, isAllowedDownloadUrl, decompressBuffer, toCleanUtf8, validateAndFormatSubtitle
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
  timing?: { original: number; references: number; compute: number };
}

export interface Prepared {
  /** the original subtitle as clean SRT */
  original: Promise<string>;
  /** the decision (after the original is loaded) */
  served: Promise<Served>;
  startedAt: number;
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
  if (!validation.valid) throw new Error(validation.reason || 'invalid subtitle');
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
export async function loadFirst(urls: string[], allowedHosts: string[], baseUrl: string): Promise<{ text: string; url: string }> {
  const failures: string[] = [];
  for (const url of urls) {
    const own = url.startsWith(baseUrl + '/');
    if (!own && !isAllowedDownloadUrl(url, allowedHosts)) continue;
    const host = new URL(url).hostname;
    const label = `${host}${new URL(url).pathname.split('/').slice(0, 4).join('/')}`;
    if (!own && isBlocked(host)) {
      failures.push(`${label}: skipped (refusing this server for now)`);
      continue;
    }
    try {
      const text = await loadOriginal(url, allowedHosts);
      if (failures.length) Logger.info(`[DOWNLOAD] served from a backup source (${host}) after: ${failures.join('; ')}`);
      return { text, url };
    } catch (err: unknown) {
      failures.push(`${label}: ${describe(err)}`);
      if (!own) noteRefusal(host, statusOf(err), describe(err));
    }
  }
  Logger.warn(`[DOWNLOAD] no source of the subtitle could be downloaded: ${failures.join('; ') || 'no allowed link'}`);
  throw new Error(failures.length ? `every source failed (${failures.join('; ')})` : 'no allowed link');
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
  if (fitsReferences(result) || result.references.length === 0 || alternatives.length === 0 || !(await referencesAgreeInWorker(refs))) {
    return { result };
  }
  for (const alt of alternatives) {
    if (!alt.u.startsWith(baseUrl + '/') && !isAllowedDownloadUrl(alt.u, hosts)) continue;
    try {
      const altText = (await loadFirst(linksOf(alt), hosts, baseUrl)).text;
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
export function prepareAligned(token: AlignedToken, query: SubtitleQuery, config: UserConfig, baseUrl: string): Prepared {
  const key = preparedKey(token);
  const existing = prepared.get(key);
  if (existing) return existing;

  const hosts = addonHostsOf(config);
  const started = Date.now();
  const timing = { original: 0, references: 0, compute: 0 };
  // the subtitle and the references are fetched at the same time
  const original = loadFirst(linksOf(token), hosts, baseUrl).then(r => { timing.original = Date.now() - started; return r.text; });
  const references = getReferences({ query, config, baseUrl, filename: token.f })
    .then(refs => { timing.references = Date.now() - started; return refs; });
  const served = Promise.all([original, references]).then(async ([text, refs]) => {
    const computeStart = Date.now();
    const s = await alignOrReplace(text, token.r, token.f, refs, token.a || [], hosts, baseUrl);
    timing.compute = Date.now() - computeStart;
    return { ...s, timing };
  });
  const entry: Prepared = { original, served, startedAt: Date.now() };
  prepared.set(key, entry);
  // a failure is not kept: the next request tries again (and a preparation nobody waits for never throws)
  original.catch(() => undefined);
  served.catch(() => { if (prepared.get(key) === entry) prepared.delete(key); });
  return entry;
}

export function clearPrepared(): void {
  prepared.clear();
}
