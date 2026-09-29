import { BaseSubtitleProvider } from './base';
import { SubtitleQuery, ProviderContext, RawSubtitleItem } from '../types/provider';
import { ENV } from '../config/env';
import { Logger } from '../utils/logger';

interface SubsRoItem {
  id: number | string;
  title?: string;
  description?: string;
  release?: string;
  translator?: string;
  language?: string;
  [key: string]: unknown;
}

interface SubsRoSearchResponse {
  items?: SubsRoItem[];
}

// Subs.ro language codes -> ISO 639-2
const SUBSRO_LANGUAGE_MAP: Record<string, string> = {
  ro: 'ron',
  en: 'eng',
  ita: 'ita',
  fra: 'fra',
  ger: 'deu',
  ung: 'hun',
  gre: 'ell',
  por: 'por',
  spa: 'spa',
  alt: 'und'
};

let rawItemLogged = false;

/**
 * Extracts season/episode hints from a title (e.g. "S03E09", "3x09", "Sezon 3").
 */
function parseSeasonEpisode(text: string): { season: number | null; episode: number | null } {
  const se = text.match(/s(\d{1,2})[\s._-]*e(\d{1,3})/i) || text.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  if (se) {
    return { season: parseInt(se[1], 10), episode: parseInt(se[2], 10) };
  }
  const season = text.match(/(?:season|sezon(?:ul)?)\s*(\d{1,2})/i) || text.match(/\bs(\d{1,2})\b/i);
  return { season: season ? parseInt(season[1], 10) : null, episode: null };
}

export class SubsRoProvider extends BaseSubtitleProvider {
  readonly id = 'subsro';
  readonly name = 'Subs.ro';
  readonly description = 'Romanian subtitles database (official Subs.ro API)';
  readonly requiresApiKey = true;
  readonly defaultEnabled = true;

  protected async executeSearch(
    query: SubtitleQuery,
    context: ProviderContext,
    signal: AbortSignal
  ): Promise<RawSubtitleItem[]> {
    const apiKey = context.providerConfig?.apiKey || ENV.DEFAULT_SUBSRO_API_KEY;
    if (!apiKey || !query.imdbId) {
      return [];
    }

    const imdbId = query.imdbId.startsWith('tt') ? query.imdbId : `tt${query.imdbId}`;
    const isSeries = query.season !== null && query.episode !== null;

    const response = await this.httpGet<SubsRoSearchResponse>(
      `https://api.subs.ro/v1.0/search/imdbid/${imdbId}`,
      {
        headers: { 'X-Subs-Api-Key': apiKey },
        timeout: 10000
      },
      signal
    );

    const list = Array.isArray(response.data?.items) ? response.data.items : [];

    if (!rawItemLogged && list.length > 0) {
      rawItemLogged = true;
      Logger.info('[SUBSRO] Example raw item from API', { item: list[0] });
    }

    const items: RawSubtitleItem[] = [];

    for (const sub of list) {
      if (sub.id === undefined || sub.id === null) continue;

      const rawLang = String(sub.language || '').toLowerCase();
      const lang = SUBSRO_LANGUAGE_MAP[rawLang] || rawLang || 'unknown';
      // Subs.ro exposes no release name: 'description' is free text (e.g. 'Sezonul 1 complet, 9 episoade, pentru WEB-DL')
      const cleanDesc = String(sub.description || '').replace(/[^\p{L}\p{N}\s.,+-]/gu, ' ').replace(/\s+/g, ' ').trim();
      const release = [sub.title, cleanDesc].filter(Boolean).join(' - ').trim() || `Subs.ro ${sub.id}`;

      // Series: drop packs that clearly belong to a different season/episode
      if (isSeries) {
        const hint = parseSeasonEpisode(`${sub.title || ''} ${sub.description || ''}`);
        if (hint.season !== null && hint.season !== query.season) continue;
        if (hint.episode !== null && hint.episode !== query.episode) continue;
      }

      const params = new URLSearchParams({ apiKey, filename: `${release}.srt` });
      if (isSeries) {
        params.set('season', String(query.season));
        params.set('episode', String(query.episode));
      }

      items.push({
        id: `subsro-${sub.id}`,
        provider: this.id,
        providerName: 'Subs.ro',
        url: `/proxy/download/subsro/${encodeURIComponent(String(sub.id))}?${params.toString()}`,
        lang,
        release,
        format: 'srt',
        rawMetadata: { translator: sub.translator }
      });
    }

    return items;
  }
}
