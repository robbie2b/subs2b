import axios from 'axios';
import { LRUCache } from 'lru-cache';
import { BaseSubtitleProvider } from './base';
import { SubtitleQuery, ProviderContext, RawSubtitleItem } from '../types/provider';
import { normalizeLanguageCode } from '../utils/languages';
import { titleInfoOf, titleTokens, jaccard } from '../utils/titleInfo';
import { htmlText, BROWSER_UA } from '../utils/html';
import { Logger } from '../utils/logger';

/**
 * Addic7ed: TV series subtitles made for exact releases ("Version FoV", "BluRay.x264-TRiPS"), mostly English, some
 * Romanian. No API: the show is found with search.php (slow, ~7 s: done once and remembered), then the episode page
 * serie/<Show>/<season>/<episode>/x lists every version and language with a link /original/<id>/<n> (or /updated/...),
 * served only with a Referer of the episode page (/sub/proxy adds it).
 */

export const ADDIC7ED_BASE = 'https://www.addic7ed.com/';

/** Show paths ("Utopia_%28UK%29") per IMDb id; the search is slow and the answer does not change */
const showCache = new LRUCache<string, Promise<string[]>>({ max: 500, ttl: 7 * 24 * 60 * 60 * 1000 });

/** The shows a search page links to (episode links "serie/<Show>/<s>/<e>/<name>"), with their display name */
export function showsFromSearch(html: string): Array<{ path: string; name: string }> {
  const shows = new Map<string, string>();
  for (const m of html.matchAll(/href="\/?serie\/([^/"]+)\/\d+\/\d+\/[^"]*"/gi)) {
    if (!shows.has(m[1])) shows.set(m[1], decodeURIComponent(m[1]).replace(/_/g, ' '));
  }
  return [...shows.entries()].map(([path, name]) => ({ path, name }));
}

/** Of the shows found, the ones that are this title (and this year, when the site names one) */
export function pickShows(shows: Array<{ path: string; name: string }>, title: string, year: number | null): string[] {
  const ref = titleTokens(title);
  const scored = shows.map(s => {
    const base = s.name.replace(/\s*\(([^)]*)\)\s*$/, '');
    const tag = /\(([^)]*)\)\s*$/.exec(s.name)?.[1] || '';
    const sim = jaccard(ref, titleTokens(base));
    const tagYear = /^\d{4}$/.test(tag) ? parseInt(tag, 10) : null;
    return { path: s.path, sim, yearOk: tagYear === null || year === null || Math.abs(tagYear - year) <= 1, exactYear: tagYear !== null && tagYear === year };
  }).filter(s => s.sim >= 0.5 && s.yearOk);
  const exact = scored.filter(s => s.exactYear);
  return (exact.length ? exact : scored).sort((a, b) => b.sim - a.sim).slice(0, 2).map(s => s.path);
}

export interface Addic7edEntry {
  version: string;
  language: string;
  link: string;
  completed: boolean;
  hearingImpaired: boolean;
  downloads: number | null;
}

/** Reads the versions of an episode page: each "Version ..." block, its languages and their download links */
export function parseAddic7edEpisode(html: string): Addic7edEntry[] {
  const entries: Addic7edEntry[] = [];
  const blocks = html.split(/class="NewsTitle"/i).slice(1);
  for (const block of blocks) {
    const version = htmlText(/Version\s+([^<]*?),\s*Duration/i.exec(block)?.[1] || '');
    const hearingImpaired = /title="Hearing Impaired"/i.test(block);
    for (const m of block.matchAll(/class="language">([\s\S]*?)<[\s\S]*?<td[^>]*>\s*<b>\s*([^<]*?)\s*<\/b>[\s\S]*?href="(\/(?:original|updated)\/[^"]+)"[\s\S]*?(?:(\d+)\s+Downloads|<\/table>)/gi)) {
      entries.push({
        version,
        language: htmlText(m[1]),
        completed: /^completed$/i.test(m[2].trim()),
        link: m[3],
        hearingImpaired,
        downloads: m[4] ? parseInt(m[4], 10) : null
      });
    }
  }
  return entries;
}

export function addic7edItems(entries: Addic7edEntry[], query: SubtitleQuery, showName: string, episodeUrl: string): RawSubtitleItem[] {
  const items: RawSubtitleItem[] = [];
  const se = `S${String(query.season).padStart(2, '0')}E${String(query.episode).padStart(2, '0')}`;
  const showDots = showName.replace(/\s*\([^)]*\)\s*$/, '').replace(/[^A-Za-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
  for (const e of entries) {
    if (!e.completed) continue;
    const lang = normalizeLanguageCode(e.language);
    if (!lang) continue;
    const download = new URL(e.link, ADDIC7ED_BASE).toString();
    // "HDTV.x264-FoV" -> "Show.S01E02.HDTV.x264-FoV"; a bare group ("FoV") -> "Show.S01E02-FoV"
    const version = e.version.replace(/\s+/g, '.');
    const release = /[.-]/.test(version) ? `${showDots}.${se}.${version}` : `${showDots}.${se}-${version}`;
    items.push({
      id: `addic7ed-${e.link.replace(/[^0-9a-z]+/gi, '-').replace(/^-|-$/g, '')}`,
      provider: 'addic7ed',
      providerName: 'Addic7ed',
      url: `/sub/proxy?url=${encodeURIComponent(download)}&ref=${encodeURIComponent(episodeUrl)}&filename=${encodeURIComponent(`${release}.srt`)}`,
      lang,
      release,
      format: 'srt',
      hearingImpaired: e.hearingImpaired || undefined,
      downloads: e.downloads ?? undefined
    });
  }
  return items;
}

/** The show paths for a series (searched once, without the provider's time limit, then remembered) */
function showsFor(query: SubtitleQuery, title: string, year: number | null): Promise<string[]> {
  const key = query.imdbId || title;
  let pending = showCache.get(key);
  if (!pending) {
    pending = axios.get<string>(`${ADDIC7ED_BASE}search.php`, {
      params: { search: title, Submit: 'Search' },
      timeout: 20000,
      responseType: 'text',
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' }
    }).then(res => {
      const shows = pickShows(showsFromSearch(String(res.data || '')), title, year);
      Logger.info(`[ADDIC7ED] shows for ${title}: ${shows.join(', ') || 'none'}`);
      return shows;
    });
    showCache.set(key, pending);
    // a failure is not remembered for a week: tried again in 10 minutes
    pending.catch(() => { showCache.set(key, Promise.resolve([]), { ttl: 10 * 60 * 1000 }); });
  }
  return pending;
}

export class Addic7edProvider extends BaseSubtitleProvider {
  readonly id = 'addic7ed';
  readonly name = 'Addic7ed';
  readonly description = 'TV series subtitles made for exact releases, from Addic7ed (no key needed).';
  readonly requiresApiKey = false;
  readonly defaultEnabled = false;

  protected async executeSearch(query: SubtitleQuery, _context: ProviderContext, signal: AbortSignal): Promise<RawSubtitleItem[]> {
    if (query.season == null || query.episode == null) return [];
    const info = await titleInfoOf(query, signal, 'Addic7ed');
    if (!info) return [];
    // (the show search goes on after this provider's time limit, so the next request finds it)
    const shows = await Promise.race([
      showsFor(query, info.name, info.year),
      new Promise<string[]>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason || new Error('aborted')), { once: true }))
    ]);
    const all: RawSubtitleItem[] = [];
    for (const show of shows) {
      const episodeUrl = `${ADDIC7ED_BASE}serie/${show}/${query.season}/${query.episode}/x`;
      const res = await this.httpGet<string>(episodeUrl, {
        timeout: 8000,
        responseType: 'text',
        headers: { Accept: 'text/html', 'User-Agent': BROWSER_UA }
      }, signal);
      const html = String(res.data || '');
      if (!/addic7ed/i.test(html)) throw new Error('Addic7ed did not answer with its episode page (blocked or changed?)');
      all.push(...addic7edItems(parseAddic7edEpisode(html), query, decodeURIComponent(show).replace(/_/g, ' '), episodeUrl));
    }
    return all;
  }
}
