import { BaseSubtitleProvider } from './base';
import { SubtitleQuery, ProviderContext, RawSubtitleItem } from '../types/provider';
import { normalizeLanguageCode } from '../utils/languages';
import { htmlText, BROWSER_UA } from '../utils/html';

/**
 * Titrari.ro: a large Romanian subtitle site (no API). Searched by IMDb id:
 * index.php?page=cautamainaltaparte&z8=<1 Romanian | -1 every language>&z5=<IMDb number>. Each result has the title,
 * the language, the release names (in "Comentariu"), the frame rate and a download link get.php?id=..., which is a RAR
 * or ZIP archive served only with a Referer of the site (/sub/proxy adds it).
 */

export const TITRARI_BASE = 'https://www.titrari.ro/';

/** The site's language labels (Romanian), in English for the common language lookup */
const LANGUAGES: Record<string, string> = {
  romana: 'romanian', engleza: 'english', spaniola: 'spanish', germana: 'german', italiana: 'italian',
  portugheza: 'portuguese', franceza: 'french', ceha: 'czech', rusa: 'russian', maghiara: 'hungarian'
};

export interface TitrariEntry {
  id: string;
  title: string;
  imdb: string | null;
  language: string;
  releases: string;
  fps: string | null;
  downloads: number | null;
}

/** Reads the results of a search page */
export function parseTitrariPage(html: string): TitrariEntry[] {
  const entries: TitrariEntry[] = [];
  // every result starts with its picture cell (they all sit in one table)
  const blocks = html.split(/<td rowspan=4 class=row1 width=1 align=center>/i).slice(1);
  for (const block of blocks) {
    const id = /get\.php\?id=(\d+)/i.exec(block)?.[1];
    if (!id) continue;
    const titleHtml = /<h1>([\s\S]*?)<\/h1>/i.exec(block)?.[1] || '';
    const imdb = /z5=(\d{5,9})/i.exec(block)?.[1] || null;
    // the language cell ("[ Romana ]" above its flag), not a bracket of the title ("Chaser [Chugyeogja]")
    const language = (/align=center>\s*\[\s*([^\]<]+?)\s*\]\s*<br>/i.exec(block)?.[1] || '').trim();
    const comment = /<td class=comment width=100%>([\s\S]*?)<\/td>/i.exec(block)?.[1] || '';
    const fps = /Framerate:\s*<b>([^<]+)<\/b>/i.exec(block)?.[1]?.trim() || null;
    const downloads = /Descarcari:\s*(\d+)/i.exec(block)?.[1];
    entries.push({
      id,
      title: htmlText(titleHtml),
      imdb: imdb ? `tt${imdb.padStart(7, '0')}` : null,
      language,
      releases: htmlText(comment),
      fps,
      downloads: downloads ? parseInt(downloads, 10) : null
    });
  }
  return entries;
}

/** "Sezonul 2" / "Season 2" in a title, or null */
const seasonInTitle = (title: string): number | null => {
  const m = /\b(?:sezonul|season|sez\.?)\s*(\d{1,2})\b/i.exec(title);
  return m ? parseInt(m[1], 10) : null;
};

/** Release names in a free comment: the words that look like release names, joined with ";" */
export function releasesFromComment(comment: string): string {
  const names = comment.split(/[\s,;|]+/)
    .map(w => w.replace(/^[([{"']+|[)\]}"'.:]+$/g, ''))
    .filter(w => w.length >= 8 && /[A-Za-z0-9]\.[A-Za-z0-9]/.test(w) &&
      ((w.match(/[._]/g) || []).length >= 2 || /(?:720p|1080p|2160p|hdtv|web|bluray|brrip|dvdrip|xvid|x264|x265)/i.test(w)) &&
      ((w.match(/[._]/g) || []).length >= 3 || /-|(?:720p|1080p|2160p|hdtv|web|bluray|brrip|dvdrip|xvid|x264|x265)/i.test(w)));
  return [...new Set(names)].join('; ');
}

export function titrariItems(entries: TitrariEntry[], query: SubtitleQuery): RawSubtitleItem[] {
  const isSeries = query.season != null && query.episode != null;
  const items: RawSubtitleItem[] = [];
  for (const e of entries) {
    if (query.imdbId && e.imdb && e.imdb !== query.imdbId) continue;
    const label = e.language.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const lang = normalizeLanguageCode(LANGUAGES[label] || label);
    if (!lang) continue;
    const season = seasonInTitle(e.title);
    if (isSeries && season !== null && season !== query.season) continue;
    const releases = releasesFromComment(e.releases);
    const name = releases || (isSeries
      ? `${e.title.replace(/\s*\(\d{4}\)\s*$/, '').replace(/\s*-?\s*(?:sezonul|season)\s*\d+.*$/i, '')} S${String(season ?? query.season).padStart(2, '0')}`
      : e.title);
    const download = `${TITRARI_BASE}get.php?id=${e.id}`;
    items.push({
      id: `titrari-${e.id}`,
      provider: 'titrari',
      providerName: 'Titrari.ro',
      url: `/sub/proxy?url=${encodeURIComponent(download)}&filename=${encodeURIComponent(`titrari-${e.id}.srt`)}`,
      lang,
      release: name,
      format: 'srt',
      downloads: e.downloads ?? undefined
    });
  }
  return items;
}

export class TitrariProvider extends BaseSubtitleProvider {
  readonly id = 'titrari';
  readonly name = 'Titrari.ro';
  readonly description = 'Romanian subtitles from Titrari.ro (no key needed).';
  readonly requiresApiKey = false;
  readonly defaultEnabled = false;

  protected async executeSearch(query: SubtitleQuery, _context: ProviderContext, signal: AbortSignal): Promise<RawSubtitleItem[]> {
    if (!query.imdbId) return [];
    const imdbNumber = query.imdbId.replace(/^tt/, '');
    const url = `${TITRARI_BASE}index.php?page=cautamainaltaparte&z8=${query.allLanguages ? -1 : 1}&z5=${imdbNumber}`;
    const res = await this.httpGet<string>(url, { timeout: 8000, responseType: 'text', headers: { Accept: 'text/html', 'User-Agent': BROWSER_UA } }, signal);
    const html = String(res.data || '');
    // a block page (or a changed site) instead of the search page is a failure, shown as such in Debug
    if (!/titrari\.ro/i.test(html) || !/name=cautare/i.test(html)) throw new Error('Titrari.ro did not answer with its search page (blocked or changed?)');
    return titrariItems(parseTitrariPage(html), query);
  }
}
