import { BaseSubtitleProvider } from './base';
import { SubtitleQuery, ProviderContext, RawSubtitleItem } from '../types/provider';
import { titleInfoOf } from '../utils/titleInfo';
import { htmlText, BROWSER_UA } from '../utils/html';
import { releasesFromComment } from './titrari';

/**
 * Subtitrari-noi.ro: Romanian subtitles (no API). The site's own search (POST paginare_filme.php, by title: its IMDb
 * search is broken) lists each subtitle with its IMDb link, a ZIP archive and a line with the release names
 * ("A; B si C"). The results are kept only for the IMDb id being played.
 */

export const SUBTITRARI_NOI_BASE = 'https://www.subtitrari-noi.ro/';

export interface SubtitrariNoiEntry {
  id: string;
  title: string;
  imdb: string | null;
  zip: string;
  releases: string;
  downloads: number | null;
}

export function parseSubtitrariNoiPage(html: string): SubtitrariNoiEntry[] {
  const entries: SubtitrariNoiEntry[] = [];
  const blocks = html.split(/<div id="round">/i).slice(1);
  for (const block of blocks) {
    const id = /movie_details&(?:amp;)?act=1&(?:amp;)?id=(\d+)/i.exec(block)?.[1];
    const zip = /class="buton"><a href="([^"]+\.zip)"/i.exec(block)?.[1];
    if (!id || !zip) continue;
    const title = /movie_details[^>]*>([^<]+)<\/a>/i.exec(block)?.[1] || '';
    const imdb = /imdb\.com\/title\/(?:tt)*(\d{5,9})/i.exec(block)?.[1];
    // the release names: the italic line after the block
    const notes = /<div style="font-weight:bold;font-style:italic[^"]*">([\s\S]*?)<\/div>/i.exec(block)?.[1] || '';
    const downloads = /Descarcari:\s*(\d+)/i.exec(block)?.[1];
    entries.push({
      id,
      title: htmlText(title),
      imdb: imdb ? `tt${imdb.padStart(7, '0')}` : null,
      zip,
      releases: htmlText(notes.replace(/\(\s*<b>[\s\S]*?NOU![\s\S]*?<\/b>\s*\)/gi, '')),
      downloads: downloads ? parseInt(downloads, 10) : null
    });
  }
  return entries;
}

const seasonIn = (text: string): number | null => {
  const m = /\b(?:sezonul|season)\s*(\d{1,2})\b|\bS(\d{1,2})(?:E\d|\b)/i.exec(text);
  return m ? parseInt(m[1] || m[2], 10) : null;
};

export function subtitrariNoiItems(entries: SubtitrariNoiEntry[], query: SubtitleQuery): RawSubtitleItem[] {
  const isSeries = query.season != null && query.episode != null;
  const items: RawSubtitleItem[] = [];
  for (const e of entries) {
    // only the content being played (the search is by title)
    if (!query.imdbId || e.imdb !== query.imdbId) continue;
    const season = seasonIn(`${e.title} ${e.releases}`);
    if (isSeries && season !== null && season !== query.season) continue;
    const releases = releasesFromComment(e.releases);
    const name = releases || (isSeries
      ? `${e.title.replace(/\s*\(\d{4}\)\s*$/, '')} S${String(season ?? query.season).padStart(2, '0')}`
      : e.title);
    const download = new URL(e.zip, SUBTITRARI_NOI_BASE).toString();
    items.push({
      id: `subtitrarinoi-${e.id}`,
      provider: 'subtitrarinoi',
      providerName: 'Subtitrari-noi.ro',
      url: `/sub/proxy?url=${encodeURIComponent(download)}&filename=${encodeURIComponent(`subtitrarinoi-${e.id}.srt`)}`,
      lang: 'ron',
      release: name,
      format: 'srt',
      downloads: e.downloads ?? undefined
    });
  }
  return items;
}

export class SubtitrariNoiProvider extends BaseSubtitleProvider {
  readonly id = 'subtitrarinoi';
  readonly name = 'Subtitrari-noi.ro';
  readonly description = 'Romanian subtitles from Subtitrari-noi.ro (no key needed).';
  readonly requiresApiKey = false;
  readonly defaultEnabled = false;

  protected async executeSearch(query: SubtitleQuery, _context: ProviderContext, signal: AbortSignal): Promise<RawSubtitleItem[]> {
    if (!query.imdbId) return [];
    const info = await titleInfoOf(query, signal, 'Subtitrari-noi.ro');
    if (!info) return [];
    const form = new URLSearchParams({ search_q: '1', query_q: info.name, cautare: info.name, tip: '2', an: '', gen: '' });
    const res = await this.httpPost<string>(`${SUBTITRARI_NOI_BASE}paginare_filme.php`, form.toString(), {
      timeout: 8000,
      responseType: 'text',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': BROWSER_UA,
        Referer: SUBTITRARI_NOI_BASE
      }
    }, signal);
    const html = String(res.data || '');
    if (!/table\.css|id="round"/i.test(html)) throw new Error('Subtitrari-noi.ro did not answer with search results (blocked or changed?)');
    return subtitrariNoiItems(parseSubtitrariNoiPage(html), query);
  }
}
