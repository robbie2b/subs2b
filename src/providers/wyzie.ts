import { BaseSubtitleProvider } from './base';
import { SubtitleQuery, ProviderContext, RawSubtitleItem } from '../types/provider';
import { normalizeLanguageCode, mapWhitelistToIso1 } from '../utils/languages';

/**
 * Wyzie Subs (sub.wyzie.io): a subtitle API that gathers several sources at once (OpenSubtitles, SubDL and others),
 * in every language. A free key (store.wyzie.io/redeem) gives 1,000 requests per UTC day; each search and each
 * download counts one. Searched with source=all (every source the key may use); the format of the answer is the one
 * of the official client, wyzie-lib. "No subtitles found" comes back as a 400: an empty answer, not a failure.
 * A download link (https://sub.wyzie.io/c/...) carries its own token, so the key is not repeated in it.
 */

export const WYZIE_BASE = 'https://sub.wyzie.io/';

export interface WyzieSubtitle {
  id: string;
  url: string;
  format?: string | null;
  encoding?: string | null;
  isHearingImpaired?: boolean;
  media?: string;
  display?: string;
  language?: string;
  source?: string | string[];
  release?: string | null;
  releases?: string[];
  fileName?: string | null;
  origin?: string | null;
}

export function wyzieItems(list: WyzieSubtitle[]): RawSubtitleItem[] {
  const items: RawSubtitleItem[] = [];
  for (const s of list) {
    if (!s || typeof s.url !== 'string' || !s.url.startsWith('http')) continue;
    // AI translations are left out (a person's subtitle is wanted, and they spend requests)
    if (s.source === 'ai' || (Array.isArray(s.source) && s.source.includes('ai'))) continue;
    const format = (s.format || 'srt').toLowerCase();
    if (format !== 'srt' && format !== 'vtt') continue;
    const lang = normalizeLanguageCode(s.language || s.display || '');
    if (!lang) continue;
    const releases = (s.releases && s.releases.length ? s.releases : s.release ? [s.release] : []).filter(Boolean);
    const release = releases.length ? releases.join('; ') : (s.fileName || s.media || 'Wyzie subtitle').replace(/\.(srt|vtt)$/i, '');
    items.push({
      id: `wyzie-${s.id}`,
      provider: 'wyzie',
      providerName: `Wyzie${s.source ? ` (${Array.isArray(s.source) ? s.source.join(', ') : s.source})` : ''}`,
      url: `/sub/proxy?url=${encodeURIComponent(s.url)}&filename=${encodeURIComponent(`wyzie-${s.id}.${format}`)}`,
      lang,
      release,
      format,
      hearingImpaired: s.isHearingImpaired || undefined
    });
  }
  return items;
}

export class WyzieProvider extends BaseSubtitleProvider {
  readonly id = 'wyzie';
  readonly name = 'Wyzie';
  readonly description = 'Subtitle API gathering several sources in every language (sub.wyzie.io). Free key, 1,000 requests a day.';
  readonly requiresApiKey = true;
  readonly defaultEnabled = false;

  protected async executeSearch(query: SubtitleQuery, context: ProviderContext, signal: AbortSignal): Promise<RawSubtitleItem[]> {
    const key = context.providerConfig?.apiKey?.trim();
    if (!key || !query.imdbId) return [];
    const params: Record<string, string | number> = { id: query.imdbId, source: 'all', format: 'srt,vtt', key };
    if (query.season != null && query.episode != null) {
      params.season = query.season;
      params.episode = query.episode;
    }
    if (!query.allLanguages) {
      const langs = mapWhitelistToIso1(
        context.config.languages && context.config.languages.length ? context.config.languages : ['eng'],
        context.config.language_remapping || context.config.languageRemap
      );
      if (langs.length) params.language = langs.join(',');
    }
    const res = await this.httpGet<unknown>(`${WYZIE_BASE}search`, {
      params,
      timeout: 10000,
      // 400 "No subtitles found" is an empty answer; other errors are failures (with the API's message)
      validateStatus: s => s < 500
    }, signal);
    if (Array.isArray(res.data)) return wyzieItems(res.data as WyzieSubtitle[]);
    const body = (res.data || {}) as { message?: string; details?: string };
    if (res.status === 400 && /no subtitles found|no matching/i.test(String(body.message || ''))) return [];
    throw new Error(`Wyzie answered ${res.status}: ${body.message || 'unexpected answer'}${body.details ? ` (${body.details})` : ''}`);
  }
}
