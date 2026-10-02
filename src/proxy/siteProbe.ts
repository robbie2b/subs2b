import axios from 'axios';
import { USER_AGENT } from '../config/version';
import { toCleanUtf8 } from './subtitleProxy';

/**
 * Looking at a subtitle site's page FROM THIS SERVER (Debug, before a new source is written): what it answers to
 * Render (a block page, a redirect...) and how its search and download pages are built. Only the sites being
 * considered as sources can be fetched, and redirects must stay on them: it is not an open proxy.
 */

export const PROBE_HOSTS = [
  'titrari.ro',
  'subtitrari-noi.ro',
  'yifysubtitles.ch', 'yifysubtitles.org', 'yts-subs.com',
  'addic7ed.com',
  'wyzie.ru', 'wyzie.io'
];

const MAX_BODY = 300 * 1024;

const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

export function probeAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const host = u.hostname.toLowerCase();
    return PROBE_HOSTS.some(h => host === h || host.endsWith('.' + h));
  } catch {
    return false;
  }
}

export interface ProbeResult {
  url: string;
  status: number;
  finalUrl?: string;
  ms: number;
  headers: Record<string, string>;
  bytes: number;
  body: string;
  truncated: boolean;
  error?: string;
}

export interface ProbeOptions {
  as?: 'browser' | 'addon';
  /** page sent as Referer (the sites that only serve downloads "from their own pages") */
  referer?: string;
  /** page opened first, whose cookies (a PHP session...) go with the request */
  warm?: string;
  /** url-encoded form: the request is a POST */
  form?: string;
  /** sent as an XMLHttpRequest (pages loaded by the site's own scripts) */
  ajax?: boolean;
}

const cookiesOf = (setCookie: unknown): string =>
  (Array.isArray(setCookie) ? setCookie : setCookie ? [String(setCookie)] : []).map(c => String(c).split(';')[0]).join('; ');

/** Fetches one page as a browser (or as this addon, with as='addon') would, and returns what came back */
export async function probeSite(url: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const as = opts.as || 'browser';
  const started = Date.now();
  let finalUrl = url;
  try {
    let cookie = '';
    if (opts.warm && probeAllowed(opts.warm)) {
      const warm = await axios.get(opts.warm, {
        timeout: 15000, maxRedirects: 5, validateStatus: () => true, responseType: 'arraybuffer',
        beforeRedirect: (options: { href?: string }) => {
          if (!probeAllowed(options.href || '')) throw new Error(`redirect to a site that is not allowed: ${options.href}`);
        },
        headers: { 'User-Agent': as === 'addon' ? USER_AGENT : BROWSER }
      });
      cookie = cookiesOf(warm.headers['set-cookie']);
    }
    const res = await axios.request<ArrayBuffer>({
      url,
      method: opts.form !== undefined ? 'POST' : 'GET',
      data: opts.form,
      responseType: 'arraybuffer',
      timeout: 15000,
      maxRedirects: 5,
      maxContentLength: 5 * 1024 * 1024,
      validateStatus: () => true,
      beforeRedirect: (options: { href?: string }) => {
        finalUrl = options.href || finalUrl;
        if (!probeAllowed(finalUrl)) throw new Error(`redirect to a site that is not allowed: ${finalUrl}`);
      },
      headers: {
        'User-Agent': as === 'addon' ? USER_AGENT : BROWSER,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
        ...(opts.referer && probeAllowed(opts.referer) ? { Referer: opts.referer } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(opts.form !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}),
        ...(opts.ajax ? { 'X-Requested-With': 'XMLHttpRequest' } : {})
      }
    });
    const buffer = Buffer.from(res.data);
    const keep = ['content-type', 'content-length', 'content-disposition', 'server', 'cf-ray', 'cf-mitigated', 'location', 'set-cookie', 'retry-after', 'x-ratelimit-remaining'];
    const headers: Record<string, string> = {};
    for (const k of keep) {
      const v = res.headers[k];
      if (v !== undefined) headers[k] = Array.isArray(v) ? v.map(c => String(c).split(';')[0]).join(' | ') : String(v);
    }
    const textual = /text|json|xml|javascript|html/i.test(headers['content-type'] || '') || buffer.length < 2048;
    const body = textual
      ? toCleanUtf8(buffer.subarray(0, MAX_BODY), 'win1250')
      : `[binary: ${buffer.subarray(0, 16).toString('hex')}…]`;
    return { url, status: res.status, finalUrl: finalUrl !== url ? finalUrl : undefined, ms: Date.now() - started, headers, bytes: buffer.length, body, truncated: buffer.length > MAX_BODY };
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string };
    return { url, status: 0, finalUrl: finalUrl !== url ? finalUrl : undefined, ms: Date.now() - started, headers: {}, bytes: 0, body: '', truncated: false, error: e.code ? `${e.code}: ${e.message}` : e.message || String(err) };
  }
}
