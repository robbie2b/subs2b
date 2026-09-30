import { BaseSubtitleProvider } from './base';
import { SubtitleQuery, ProviderContext, RawSubtitleItem } from '../types/provider';
import { Logger } from '../utils/logger';
import { mapWhitelistToOpenSubtitles } from '../utils/languages';
import { USER_AGENT } from '../config/version';

interface OpenSubtitlesRestItem {
  id: string;
  attributes: {
    language: string;
    download_count: number;
    hearing_impaired: boolean;
    ratings: number;
    release: string;
    moviehash_match?: boolean;
    foreign_parts_only?: boolean;
    ai_translated?: boolean;
    machine_translated?: boolean;
    legacy_subtitle_id?: number;
    files: Array<{
      file_id: number;
      file_name: string;
    }>;
  };
}

interface OpenSubtitlesRestResponse {
  data: OpenSubtitlesRestItem[];
}

export class OpenSubtitlesProvider extends BaseSubtitleProvider {
  readonly id = 'opensubtitles';
  readonly name = 'OpenSubtitles';
  readonly description = 'Official OpenSubtitles.com v1 API with full metadata and exact file-hash matching';
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

    const params: Record<string, string | number> = {
      imdb_id: query.imdbId.replace(/^tt/i, '')
    };

    if (query.season !== null && query.episode !== null) {
      params.season_number = query.season;
      params.episode_number = query.episode;
      params.type = 'episode';
    } else {
      params.type = 'movie';
    }

    // Exact-file match: the player's OpenSubtitles-style hash finds subtitles made for this very file.
    // It goes in a separate request so it can never narrow the main (imdb) search.
    const rawHash = query.extra?.videoHash;
    const videoHash = rawHash && /^[0-9a-f]{16}$/i.test(rawHash) ? rawHash.toLowerCase() : null;

    // Native language filter: convert whitelist into OpenSubtitles API v1 format
    const effectiveLangs = (context.config.languages && context.config.languages.length > 0)
      ? context.config.languages
      : ['pob', 'eng'];
    const activeRemap = context.config.language_remapping || context.config.languageRemap;
    const osLangs = mapWhitelistToOpenSubtitles(effectiveLangs, activeRemap);
    // The API only accepts ISO 639-1 style codes ("ro", "pt-br"); 3-letter codes like "ron" are not valid there
    const validOsLangs = osLangs.filter(l => /^[a-z]{2}(-[a-z]{2})?$/i.test(l));
    const languageParam = (validOsLangs.length > 0 ? validOsLangs : osLangs).join(',');
    if (languageParam) {
      params.languages = languageParam;
    }

    const fetchPage = async (p: Record<string, string | number>): Promise<OpenSubtitlesRestItem[]> => {
      const res = await this.httpGet<OpenSubtitlesRestResponse>(
        'https://api.opensubtitles.com/api/v1/subtitles',
        {
          params: p,
          headers: {
            'Api-Key': apiKey,
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        },
        signal
      );
      return res.data && Array.isArray(res.data.data) ? res.data.data : [];
    };

    const hashParams: Record<string, string | number> | null = videoHash
      ? { moviehash: videoHash, ...(languageParam ? { languages: languageParam } : {}) }
      : null;

    const [mainList, hashList] = await Promise.all([
      fetchPage(params),
      hashParams ? fetchPage(hashParams).catch(() => [] as OpenSubtitlesRestItem[]) : Promise.resolve([] as OpenSubtitlesRestItem[])
    ]);

    Logger.info(`[OPENSUBTITLES] main=${mainList.length} hash=${hashList.length} langs=${languageParam}`, {
      hashMatchFlags: hashList.filter(i => i.attributes.moviehash_match === true).length
    });

    // Merge: hash results first, without repeating anything the main search already returned
    const seen = new Set<string>();
    const rawList: OpenSubtitlesRestItem[] = [];
    for (const item of [...hashList, ...mainList]) {
      const key = String(item.id);
      if (seen.has(key)) continue;
      seen.add(key);
      rawList.push(item);
    }

    const items: RawSubtitleItem[] = [];

    for (const item of rawList) {
      const attr = item.attributes;
      if (!attr || !attr.files || attr.files.length === 0) continue;

      const file = attr.files[0];
      const fileId = file.file_id;
      const legacyId = attr.legacy_subtitle_id || '';
      const fileName = file.file_name || attr.release || `${query.id}.srt`;

      const downloadProxyUrl = `/proxy/download/os-rest/${fileId}?filename=${encodeURIComponent(fileName)}&apiKey=${encodeURIComponent(apiKey)}${legacyId ? `&legacyId=${encodeURIComponent(String(legacyId))}` : ''}`;

      items.push({
        id: `os-${item.id || fileId}`,
        provider: this.id,
        providerName: 'OpenSubtitles',
        url: downloadProxyUrl,
        lang: attr.language || 'unknown',
        release: attr.release || fileName.replace(/\.(srt|vtt)$/i, ''),
        format: fileName.toLowerCase().endsWith('.vtt') ? 'vtt' : 'srt',
        hearingImpaired: Boolean(attr.hearing_impaired),
        forced: attr.foreign_parts_only === true,
        aiTranslated: attr.ai_translated === true || attr.machine_translated === true,
        rating: attr.ratings,
        downloads: attr.download_count,
        hashMatch: attr.moviehash_match === true
      });
    }

    return items;
  }
}
