import { BaseSubtitleProvider } from './base';
import { SubtitleQuery, ProviderContext, RawSubtitleItem } from '../types/provider';

interface SubsourceMovieItem {
  movieId: number;
  title: string;
  type: string;
  season?: number | null;
}

interface SubsourceSubtitleItem {
  subtitleId: number;
  language: string;
  releaseInfo?: string[];
  hearingImpaired?: boolean;
}

interface SubsourceMovieSearchResponse {
  data?: SubsourceMovieItem[];
}

interface SubsourceSubtitlesResponse {
  subtitles?: SubsourceSubtitleItem[];
  data?: SubsourceSubtitleItem[];
}

const SUBSOURCE_LANGUAGE_NAMES: Record<string, string> = {
  ron: 'romanian', eng: 'english', fra: 'french', fre: 'french', deu: 'german', ger: 'german', spa: 'spanish', ita: 'italian',
  por: 'portuguese', nld: 'dutch', pol: 'polish', hun: 'hungarian', ces: 'czech', cze: 'czech', ell: 'greek', gre: 'greek',
  tur: 'turkish', rus: 'russian', ukr: 'ukrainian', bul: 'bulgarian', srp: 'serbian', hrv: 'croatian', swe: 'swedish',
  nor: 'norwegian', dan: 'danish', fin: 'finnish', heb: 'hebrew', ara: 'arabic', zho: 'chinese', chi: 'chinese', jpn: 'japanese', kor: 'korean'
};
/** The whitelist as the names the Subsource API takes ("romanian,english"); null when a language has no known name (then no filter) */
export function subsourceLanguageNames(languages: string[] | undefined): string | null {
  if (!languages || languages.length === 0) return null;
  const names = languages.map(l => SUBSOURCE_LANGUAGE_NAMES[l.toLowerCase()]);
  return names.every(Boolean) ? [...new Set(names)].join(',') : null;
}

export class SubsourceProvider extends BaseSubtitleProvider {
  readonly id = 'subsource';
  readonly name = 'Subsource';
  readonly description = 'Community-driven high accuracy subtitles from Subsource';
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
    const timeout = context.timeoutMs || 10000;

    // 1. Search Subsource for the movie/show by IMDb ID
    const movieRes = await this.httpGet<SubsourceMovieSearchResponse>(
      'https://api.subsource.net/api/v1/movies/search',
      {
        params: { imdb: cleanImdb, searchType: 'imdb' },
        headers: { 'X-API-Key': apiKey },
        timeout
      },
      signal
    );

    const moviesList = movieRes.data?.data || [];
    if (!Array.isArray(moviesList) || moviesList.length === 0) {
      return [];
    }

    // Match season if series
    let targetMovie: SubsourceMovieItem | undefined;
    if (query.type === 'series' && query.season !== null) {
      targetMovie = moviesList.find(m => m.season === query.season);
    }
    if (!targetMovie) {
      targetMovie = moviesList.find(m => m.type === 'movie') || moviesList[0];
    }

    if (!targetMovie?.movieId) {
      return [];
    }

    // 2. Fetch subtitles for the found movieId. Without a filter the API sends one page of ~20 subtitles of every language
    // (almost none of them in the languages wanted): the languages of the whitelist are asked for by name, 100 at a time.
    // If that gives nothing (a name the API does not know), the plain request is made, as before.
    const fetchList = async (params: Record<string, string | number>) => {
      const res = await this.httpGet<SubsourceSubtitlesResponse>(
        'https://api.subsource.net/api/v1/subtitles',
        { params, headers: { 'X-API-Key': apiKey }, timeout },
        signal
      );
      const found = res.data?.subtitles || res.data?.data || [];
      return Array.isArray(found) ? found : [];
    };
    const languageNames = query.allLanguages ? null : subsourceLanguageNames(context.config.languages);
    let list = languageNames ? await fetchList({ movieId: targetMovie.movieId, language: languageNames, limit: 100 }) : [];
    if (list.length === 0) list = await fetchList({ movieId: targetMovie.movieId });
    if (list.length === 0) {
      return [];
    }

    const items: RawSubtitleItem[] = [];

    for (const sub of list) {
      // (every release the subtitle fits is a variant of the name, "A; B", as the other sources list them)
      const releaseName = (Array.isArray(sub.releaseInfo) && sub.releaseInfo.length ? sub.releaseInfo.slice(0, 6).join('; ') : '') || targetMovie.title || cleanImdb;
      const isHI = Boolean(sub.hearingImpaired || /\[cc\]|\[hi\]|\(hi\)/i.test(releaseName));
      const downloadUrl = `https://api.subsource.net/api/v1/subtitles/${sub.subtitleId}/download`;

      items.push({
        id: `subsource-${sub.subtitleId}`,
        provider: this.id,
        providerName: 'Subsource',
        url: `/sub/proxy?url=${encodeURIComponent(downloadUrl)}&p=subsource&filename=${encodeURIComponent(releaseName + '.srt')}`,
        lang: sub.language || 'unknown',
        release: releaseName,
        format: 'srt',
        hearingImpaired: isHI
      });
    }

    return items;
  }
}
