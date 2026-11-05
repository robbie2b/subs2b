import axios from 'axios';
import { BaseSubtitleProvider } from './base';
import { SubtitleQuery, ProviderContext, RawSubtitleItem } from '../types/provider';
import { Logger } from '../utils/logger';
import { USER_AGENT } from '../config/version';
import { titleInfoOf, TitleInfo, titleTokens, jaccard } from '../utils/titleInfo';

/**
 * RegieLive (Romanian subtitles) through the same search API that Bazarr uses.
 *
 * - Searches by title + year (+ season/episode) and, when the player sent one, by the playing file's name.
 *   (The IMDb id search is refused by this endpoint for the shared key, so it is not used.)
 * - RegieLive asks API users to stay under about 8 searches per minute, 2 per second and 2 at a time:
 *   the limiter below enforces that for the whole process, and the aggregator caches results anyway.
 * - Uses a personal RegieLive key when one is set in the configuration (or REGIELIVE_API_KEY);
 *   otherwise the shared Bazarr key, whose budget is shared with every other Bazarr user.
 */

export const REGIELIVE_SEARCH_URL = 'https://api.regielive.ro/bazarr/search.php';
export const REGIELIVE_DOWNLOAD_HOST = 'subtitrari.regielive.ro';
const SHARED_BAZARR_KEY = 'API-BAZARR-YTZ-SL';

export function regieLiveApiKey(personalKey?: string): string {
  return (personalKey && personalKey.trim()) || (process.env.REGIELIVE_API_KEY || '').trim() || SHARED_BAZARR_KEY;
}

export function regieLiveHeaders(apiKey: string, cookie?: string): Record<string, string> {
  return {
    'RL-API': apiKey,
    'User-Agent': `${USER_AGENT} (Stremio addon; +https://github.com/robbie2b/subs2b)`,
    'Referer': 'https://subtitrari.regielive.ro',
    'Accept': 'application/json, text/plain, */*',
    ...(cookie ? { Cookie: cookie } : {})
  };
}

// ---------------------------------------------------------------------------
// Rate limiter: max N calls per minute, max B per second, max C at once. Waits (up to maxWaitMs) for a free slot.
// ---------------------------------------------------------------------------
export class RateLimiter {
  private stamps: number[] = [];
  private active = 0;

  constructor(
    private readonly perMinute: number,
    private readonly perSecond: number,
    private readonly concurrent: number,
    private readonly maxWaitMs: number
  ) {}

  private canGo(now: number): boolean {
    this.stamps = this.stamps.filter(t => now - t < 60000);
    return this.active < this.concurrent
      && this.stamps.length < this.perMinute
      && this.stamps.filter(t => now - t < 1000).length < this.perSecond;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.maxWaitMs;
    for (;;) {
      const now = Date.now();
      if (this.canGo(now)) break;
      if (now >= deadline) throw new Error('RegieLive rate limit: no free slot, try again shortly');
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    this.active++;
    this.stamps.push(Date.now());
    try {
      return await task();
    } finally {
      this.active--;
    }
  }
}

const searchLimiter = new RateLimiter(8, 2, 2, 4000);

// ---------------------------------------------------------------------------
// Response parsing (pure, unit-tested)
// ---------------------------------------------------------------------------
interface RegieLiveResponse {
  rezultate?: Record<string, {
    film?: string | { nume?: string; titlu?: string };
    subtitrari?: Record<string, { titlu?: string; url?: string; rating?: { nota?: number | string; voturi?: number } }>;
  }>;
}

export interface DownloadTicket {
  /** archive address on subtitrari.regielive.ro */
  u: string;
  /** session cookie received with the search (may be empty) */
  c?: string;
  /** what is being played, to choose the right file inside a pack */
  s?: number | null;
  e?: number | null;
  vf?: string;
}

export function encodeTicket(ticket: DownloadTicket): string {
  return Buffer.from(JSON.stringify(ticket)).toString('base64url');
}

export function decodeTicket(data: string): DownloadTicket | null {
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    return parsed && typeof parsed.u === 'string' ? parsed as DownloadTicket : null;
  } catch {
    return null;
  }
}


/**
 * Turns a search response into subtitle items.
 * `referenceTitle`: when set (title searches), films whose name is clearly another title are skipped.
 */
export function parseRegieLiveResponse(
  data: RegieLiveResponse,
  ctx: { cookie?: string; season?: number | null; episode?: number | null; videoFilename?: string; referenceTitle?: string }
): RawSubtitleItem[] {
  const items: RawSubtitleItem[] = [];
  const refTokens = ctx.referenceTitle ? titleTokens(ctx.referenceTitle) : null;

  for (const film of Object.values(data.rezultate || {})) {
    const filmName = typeof film.film === 'string' ? film.film : (film.film?.nume || film.film?.titlu || '');
    if (refTokens && filmName && jaccard(refTokens, titleTokens(filmName)) < 0.5) continue;

    for (const [subId, sub] of Object.entries(film.subtitrari || {})) {
      const url = sub.url || '';
      // RegieLive has broken records whose link ends in "-0.zip" ("no such subtitle")
      if (!url || /-0\.zip$/i.test(url)) continue;
      let host = '';
      try { host = new URL(url).hostname; } catch { continue; }
      if (host !== REGIELIVE_DOWNLOAD_HOST) continue;

      const nota = typeof sub.rating?.nota === 'string' ? parseFloat(sub.rating.nota) : sub.rating?.nota;
      const ticket = encodeTicket({
        u: url,
        c: ctx.cookie || undefined,
        s: ctx.season ?? null,
        e: ctx.episode ?? null,
        vf: ctx.videoFilename || undefined
      });
      items.push({
        id: `regielive-${subId}`,
        provider: 'regielive',
        providerName: 'RegieLive',
        url: `/proxy/download/regielive/${ticket}`,
        lang: 'ron',
        release: sub.titlu || filmName || `RegieLive ${subId}`,
        format: 'srt',
        rating: typeof nota === 'number' && isFinite(nota) ? nota : undefined
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------
const inFlight = new Map<string, Promise<RawSubtitleItem[]>>();

export class RegieLiveProvider extends BaseSubtitleProvider {
  readonly id = 'regielive';
  readonly name = 'RegieLive';
  readonly description = 'Romanian subtitles from RegieLive (the API Bazarr uses). Works without a key; a personal key is optional.';
  readonly requiresApiKey = false;
  readonly defaultEnabled = false;

  protected async executeSearch(
    query: SubtitleQuery,
    context: ProviderContext,
    signal: AbortSignal
  ): Promise<RawSubtitleItem[]> {
    if (!query.imdbId) return [];
    const apiKey = regieLiveApiKey(context.providerConfig?.apiKey);

    const key = `${query.id}|${query.extra?.filename || ''}|${apiKey}`;
    const running = inFlight.get(key);
    if (running) return running;

    const task = this.searchAll(query, apiKey, signal).finally(() => inFlight.delete(key));
    inFlight.set(key, task);
    return task;
  }

  private async searchAll(query: SubtitleQuery, apiKey: string, signal: AbortSignal): Promise<RawSubtitleItem[]> {
    const isSeries = query.season != null && query.episode != null;
    const filename = (query.extra?.filename || '').replace(/\.[a-z0-9]{2,4}$/i, '').trim();

    const searches: Array<Promise<RawSubtitleItem[]>> = [];

    const info = await this.titleInfo(query, signal);
    if (info) {
      const params: Record<string, string> = { nume: info.name };
      if (info.year && !isSeries) params.an = String(info.year);
      if (isSeries) {
        params.sezon = String(query.season);
        params.episod = String(query.episode);
      }
      searches.push(this.callApi(params, apiKey, query, signal, info.name));
    }

    // The exact file name is RegieLive's own recommendation for hard-to-find titles
    if (filename.length >= 3) {
      const params: Record<string, string> = { fisier: filename };
      if (isSeries) {
        params.sezon = String(query.season);
        params.episod = String(query.episode);
      }
      searches.push(this.callApi(params, apiKey, query, signal));
    }

    if (searches.length === 0) return [];
    const settled = await Promise.allSettled(searches);
    const merged = new Map<string, RawSubtitleItem>();
    let firstError: unknown = null;
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        for (const item of result.value) if (!merged.has(item.id)) merged.set(item.id, item);
      } else if (!firstError) {
        firstError = result.reason;
      }
    }
    // Every search failed: report the provider as failed instead of an empty answer
    if (merged.size === 0 && firstError && settled.every(r => r.status === 'rejected')) throw firstError;
    return [...merged.values()];
  }

  private async callApi(
    params: Record<string, string>,
    apiKey: string,
    query: SubtitleQuery,
    signal: AbortSignal,
    referenceTitle?: string
  ): Promise<RawSubtitleItem[]> {
    const response = await searchLimiter.run(() =>
      axios.get<RegieLiveResponse>(REGIELIVE_SEARCH_URL, {
        params,
        headers: regieLiveHeaders(apiKey),
        timeout: 8000,
        signal,
        // 404 means "nothing found" for this API; other errors are real
        validateStatus: status => (status >= 200 && status < 300) || status === 404
      })
    );
    if (response.status === 404 || !response.data || typeof response.data !== 'object') return [];

    const setCookie = response.headers?.['set-cookie'];
    const cookie = Array.isArray(setCookie)
      ? setCookie.map(c => c.split(';')[0]).filter(c => c.startsWith('PHPSESSID=')).join('; ')
      : '';

    return parseRegieLiveResponse(response.data, {
      cookie,
      season: query.season,
      episode: query.episode,
      videoFilename: query.extra?.filename,
      referenceTitle
    });
  }

  private titleInfo(query: SubtitleQuery, signal: AbortSignal): Promise<TitleInfo | null> {
    return titleInfoOf(query, signal, 'RegieLive');
  }
}

