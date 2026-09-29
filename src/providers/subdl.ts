import { BaseSubtitleProvider } from './base';
import { SubtitleQuery, ProviderContext, RawSubtitleItem } from '../types/provider';
import { mapWhitelistToSubDL } from '../utils/languages';
import { shortHash } from '../utils/ids';

interface SubDLSubtitleItem {
  release_name: string;
  name?: string;
  lang: string;
  url: string;
  hearing_impaired?: boolean | number;
  full_url?: string;
  sub_rating?: number;
  sub_download_count?: number;
}

interface SubDLResponse {
  status: boolean;
  subtitles?: SubDLSubtitleItem[];
  results?: SubDLSubtitleItem[];
}

export class SubDLProvider extends BaseSubtitleProvider {
  readonly id = 'subdl';
  readonly name = 'SubDL';
  readonly description = 'High quality multilingual subtitles database from SubDL';
  readonly requiresApiKey = true;
  readonly defaultEnabled = true;

  protected async executeSearch(
    query: SubtitleQuery,
    context: ProviderContext,
    signal: AbortSignal
  ): Promise<RawSubtitleItem[]> {
    const apiKey = context.providerConfig?.apiKey;
    if (!apiKey || !query.imdbId) {
      return [];
    }
    const cleanImdb = query.imdbId.startsWith('tt') ? query.imdbId : `tt${query.imdbId}`;

    const params: Record<string, string | number> = {
      imdb_id: cleanImdb,
      api_key: apiKey
    };

    if (query.season !== null && query.episode !== null) {
      params.type = 'tv';
      params.season = query.season;
      params.episode = query.episode;
    } else {
      params.type = 'movie';
    }

    // Filter languages strictly by user whitelist
    const effectiveLangs = (context.config.languages && context.config.languages.length > 0)
      ? context.config.languages
      : ['pob', 'eng'];
    const activeRemap = context.config.language_remapping || context.config.languageRemap;
    const subdlLangs = mapWhitelistToSubDL(effectiveLangs, activeRemap);
    if (subdlLangs.length > 0) {
      params.languages = subdlLangs.join(',');
    }

    const response = await this.httpGet<SubDLResponse>(
      'https://api.subdl.com/api/v1/subtitles',
      { params, timeout: 10000 },
      signal
    );

    const list = response.data.subtitles || response.data.results || [];
    if (!response.data.status && list.length === 0) {
      return [];
    }

    const items: RawSubtitleItem[] = [];

    for (const sub of list) {
      if (!sub.url && !sub.full_url) continue;

      let downloadUrl = sub.full_url || sub.url;
      if (downloadUrl.startsWith('/')) {
        downloadUrl = `https://dl.subdl.com${downloadUrl}`;
      } else if (!downloadUrl.startsWith('http')) {
        downloadUrl = `https://dl.subdl.com/${downloadUrl}`;
      }

      const releaseName = sub.release_name || sub.name || cleanImdb;
      const isHI = Boolean(
        sub.hearing_impaired === true ||
        sub.hearing_impaired === 1 ||
        /\[cc\]|\.cc\.|\[hi\]|\(hi\)|hearing/i.test(releaseName)
      );

      items.push({
        id: `subdl-${shortHash(downloadUrl)}`,
        provider: this.id,
        providerName: 'SubDL',
        url: `/sub/proxy?url=${encodeURIComponent(downloadUrl)}&filename=${encodeURIComponent(releaseName + '.srt')}`,
        lang: sub.lang || 'unknown',
        release: releaseName,
        format: 'srt',
        hearingImpaired: isHI,
        rating: sub.sub_rating,
        downloads: sub.sub_download_count
      });
    }

    return items;
  }
}
