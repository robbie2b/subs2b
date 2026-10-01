import axios from 'axios';
import { LRUCache } from 'lru-cache';
import { UserConfig } from '../types/config';
import { SubtitleQuery } from '../types/provider';
import { Logger } from '../utils/logger';
import { USER_AGENT } from '../config/version';
import { AlignedToken } from './alignedToken';
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

/**
 * Aligns the subtitle; when it fits none of the references while the references agree with each other (so it was
 * clearly made for another release), the alternatives are tried in order and the first one that fits is served.
 */
async function alignOrReplace(
  text: string,
  refs: Reference[],
  alternatives: Array<{ u: string; r?: string }>,
  hosts: string[],
  baseUrl: string
): Promise<Served> {
  const result = await alignInWorker(text, refs);
  if (fitsReferences(result) || result.references.length === 0 || alternatives.length === 0 || !(await referencesAgreeInWorker(refs))) {
    return { result };
  }
  for (const alt of alternatives) {
    if (!alt.u.startsWith(baseUrl + '/') && !isAllowedDownloadUrl(alt.u, hosts)) continue;
    try {
      const altText = await loadOriginal(alt.u, hosts);
      const altResult = await alignInWorker(altText, refs);
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
  const original = loadOriginal(token.u, hosts);
  const served = original.then(text =>
    getReferences({ query, config, baseUrl, filename: token.f })
      .then(refs => alignOrReplace(text, refs, token.a || [], hosts, baseUrl)));
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
