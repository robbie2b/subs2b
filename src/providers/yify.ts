import { BaseSubtitleProvider } from './base';
import { SubtitleQuery, ProviderContext, RawSubtitleItem } from '../types/provider';
import { normalizeLanguageCode } from '../utils/languages';
import { htmlText, BROWSER_UA } from '../utils/html';

/**
 * YIFY subtitles (yts-subs.com; the yifysubtitles.ch copy is behind a Cloudflare check for this server). Films only.
 * The page of a film, by IMDb id (/movie-imdb/tt...), lists every subtitle in every language with its release name;
 * each one downloads as a ZIP from subtitles.yts-subs.com/subtitles/<slug>.zip. Many are YTS/YIFY encodes (Blu-ray or
 * WEB timing): useful references.
 */

export const YIFY_BASE = 'https://yts-subs.com/';
export const YIFY_FILES = 'https://subtitles.yts-subs.com/subtitles/';

export interface YifyEntry {
  slug: string;
  language: string;
  release: string;
  rating: number | null;
}

export function parseYifyPage(html: string): YifyEntry[] {
  const entries: YifyEntry[] = [];
  for (const m of html.matchAll(/<tr[^>]*data-id="\d+"[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = m[1];
    const slug = /href="\/subtitles\/([a-z0-9-]+)"/i.exec(row)?.[1];
    if (!slug) continue;
    const language = htmlText(/<span class="sub-lang">([\s\S]*?)<\/span>/i.exec(row)?.[1] || '');
    const link = /<a href="\/subtitles\/[^"]+">([\s\S]*?)<\/a>/i.exec(row)?.[1] || '';
    const release = htmlText(link.replace(/<span class="text-muted">subtitle<\/span>/i, ''));
    const rating = /<span class="label[^"]*">\s*(-?\d+)\s*<\/span>/i.exec(row)?.[1];
    entries.push({ slug, language, release, rating: rating ? parseInt(rating, 10) : null });
  }
  return entries;
}

export function yifyItems(entries: YifyEntry[]): RawSubtitleItem[] {
  const items: RawSubtitleItem[] = [];
  for (const e of entries) {
    const lang = normalizeLanguageCode(e.language);
    if (!lang) continue;
    const download = `${YIFY_FILES}${e.slug}.zip`;
    items.push({
      id: `yify-${e.slug}`,
      provider: 'yify',
      providerName: 'YIFY',
      url: `/sub/proxy?url=${encodeURIComponent(download)}&filename=${encodeURIComponent(`${e.slug}.srt`)}`,
      lang,
      // YIFY release names are often "The Matrix 1999 720p BrRip 264 YIFY": the group is the last word
      release: e.release.replace(/\s+(YIFY|YTS(?:\.[A-Z]{2,3})?)\s*$/i, '-$1'),
      format: 'srt',
      rating: e.rating ?? undefined
    });
  }
  return items;
}

export class YifyProvider extends BaseSubtitleProvider {
  readonly id = 'yify';
  readonly name = 'YIFY';
  readonly description = 'Film subtitles in many languages from YIFY (yts-subs.com). No key needed.';
  readonly requiresApiKey = false;
  readonly defaultEnabled = false;

  protected async executeSearch(query: SubtitleQuery, _context: ProviderContext, signal: AbortSignal): Promise<RawSubtitleItem[]> {
    // films only
    if (!query.imdbId || (query.season != null && query.episode != null) || query.type === 'series') return [];
    const res = await this.httpGet<string>(`${YIFY_BASE}movie-imdb/${query.imdbId}`, {
      timeout: 8000,
      responseType: 'text',
      // a film YIFY does not know is a 404: "nothing found", not a failure
      validateStatus: s => (s >= 200 && s < 300) || s === 404,
      headers: { Accept: 'text/html', 'User-Agent': BROWSER_UA }
    }, signal);
    if (res.status === 404) return [];
    const html = String(res.data || '');
    if (!/yts-subs|yifysubtitles/i.test(html)) throw new Error('YIFY did not answer with its film page (blocked or changed?)');
    return yifyItems(parseYifyPage(html));
  }
}
