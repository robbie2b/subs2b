import { BaseSubtitleProvider } from './base';
import { SubtitleQuery, ProviderContext, RawSubtitleItem } from '../types/provider';
import { normalizeLanguageCode, mapWhitelistToPodnapisi } from '../utils/languages';
import { titleInfoOf, titleTokens, jaccard } from '../utils/titleInfo';

/**
 * Podnapisi.net: a large free subtitle database in many languages, without a key and without a daily download quota.
 * Useful both for the user's language and as Subsync references (any language).
 *
 * Uses the search that subliminal and Bazarr use: GET /subtitles/search/old?sXML=1 with the title (sK), the language
 * (sL, two letters; left out = every language), season/episode (sTS/sTE) or year (sY). The answer is XML, in pages.
 * A subtitle downloads as a zip from /subtitles/<pid>/download?container=zip (through /sub/proxy, which unpacks it).
 */

export const PODNAPISI_BASE = 'https://www.podnapisi.net/subtitles/';
/** Pages read per search (the references search, in every language, can have many) */
const MAX_PAGES = 3;

export interface PodnapisiEntry {
  pid: string;
  title: string;
  year: number | null;
  language: string;
  releases: string[];
  season: number | null;
  episode: number | null;
  hearingImpaired: boolean;
  downloads?: number;
  rating?: number;
}

const decode = (s: string): string => s
  .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
  .replace(/&amp;/g, '&')
  .trim();

const tag = (xml: string, name: string): string | null => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decode(m[1]) : null;
};

const int = (v: string | null): number | null => {
  const n = v ? parseInt(v, 10) : NaN;
  return isNaN(n) ? null : n;
};

/** Reads one page of the XML answer */
export function parsePodnapisiXml(xml: string): { entries: PodnapisiEntry[]; page: number; pages: number } {
  const entries: PodnapisiEntry[] = [];
  const seen = new Set<string>();
  for (const m of xml.matchAll(/<subtitle>([\s\S]*?)<\/subtitle>/g)) {
    const block = m[1];
    const pid = tag(block, 'pid');
    if (!pid || seen.has(pid)) continue;   // the same subtitle can be listed twice
    seen.add(pid);
    const releases = (tag(block, 'release') || '')
      .split(/\s+/)
      .map(r => r.replace(/\.+$/, '').replace(/[^\x20-\x7e]/g, ''))
      .filter(r => r.length > 2);
    entries.push({
      pid,
      title: tag(block, 'title') || '',
      year: int(tag(block, 'year')),
      language: tag(block, 'language') || '',
      releases,
      season: int(tag(block, 'tvSeason')),
      episode: int(tag(block, 'tvEpisode')),
      hearingImpaired: (tag(block, 'flags') || '').includes('n'),
      downloads: int(tag(block, 'downloads')) ?? undefined,
      rating: int(tag(block, 'rating')) ?? undefined
    });
  }
  const pagination = tag(xml, 'pagination') || '';
  return { entries, page: int(tag(pagination, 'current')) || 1, pages: int(tag(pagination, 'count')) || 1 };
}

/** Keeps the entries of this content (title, year, episode) and turns them into subtitle items */
export function podnapisiItems(entries: PodnapisiEntry[], query: SubtitleQuery, title: string, year: number | null): RawSubtitleItem[] {
  const isSeries = query.season != null && query.episode != null;
  const ref = titleTokens(title);
  const items: RawSubtitleItem[] = [];
  for (const e of entries) {
    if (ref.length && jaccard(ref, titleTokens(e.title)) < 0.5) continue;
    if (isSeries && (e.season !== query.season || e.episode !== query.episode)) continue;
    if (!isSeries && year && e.year && Math.abs(e.year - year) > 1) continue;
    const lang = normalizeLanguageCode(e.language);
    if (!lang) continue;
    const name = e.releases.length ? e.releases.join('; ') : `${e.title}${isSeries ? ` S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}` : e.year ? ` ${e.year}` : ''}`;
    const download = `${PODNAPISI_BASE}${encodeURIComponent(e.pid)}/download?container=zip`;
    items.push({
      id: `podnapisi-${e.pid}`,
      provider: 'podnapisi',
      providerName: 'Podnapisi',
      url: `/sub/proxy?url=${encodeURIComponent(download)}&filename=${encodeURIComponent((e.releases[0] || e.pid) + '.srt')}`,
      lang,
      release: name,
      format: 'srt',
      hearingImpaired: e.hearingImpaired || undefined,
      downloads: e.downloads,
      rating: e.rating
    });
  }
  return items;
}

export class PodnapisiProvider extends BaseSubtitleProvider {
  readonly id = 'podnapisi';
  readonly name = 'Podnapisi';
  readonly description = 'Free multilingual subtitle database (podnapisi.net). No key needed.';
  readonly requiresApiKey = false;
  readonly defaultEnabled = false;

  protected async executeSearch(query: SubtitleQuery, context: ProviderContext, signal: AbortSignal): Promise<RawSubtitleItem[]> {
    const info = await titleInfoOf(query, signal, 'Podnapisi');
    if (!info) return [];
    const isSeries = query.season != null && query.episode != null;

    // every language for the references; otherwise one search per language of the whitelist
    const langs = query.allLanguages
      ? [null]
      : mapWhitelistToPodnapisi(
        context.config.languages && context.config.languages.length ? context.config.languages : ['eng'],
        context.config.language_remapping || context.config.languageRemap
      );
    if (langs.length === 0) return [];

    const searchOne = async (lang: string | null): Promise<RawSubtitleItem[]> => {
      const params: Record<string, string | number> = { sXML: 1, sK: info.name };
      if (lang) params.sL = lang;
      if (isSeries) {
        params.sTS = query.season!;
        params.sTE = query.episode!;
      } else if (info.year) {
        params.sY = info.year;
      }
      const entries: PodnapisiEntry[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await this.httpGet<string>(`${PODNAPISI_BASE}search/old`, {
          params: page > 1 ? { ...params, page } : params,
          timeout: 8000,
          responseType: 'text',
          headers: { Accept: 'application/xml, text/xml' }
        }, signal);
        const body = String(res.data || '');
        // a block page (Cloudflare...) instead of results is a failure, shown as such in Debug, not "nothing found"
        if (!/<results[\s>]/i.test(body)) throw new Error('Podnapisi did not answer with search results (blocked or changed?)');
        const parsed = parsePodnapisiXml(body);
        entries.push(...parsed.entries);
        if (parsed.page >= parsed.pages || parsed.entries.length === 0) break;
      }
      return podnapisiItems(entries, query, info.name, info.year);
    };

    const results = await Promise.all(langs.map(searchOne));
    const unique = new Map<string, RawSubtitleItem>();
    for (const list of results) for (const item of list) if (!unique.has(item.id)) unique.set(item.id, item);
    return [...unique.values()];
  }
}
