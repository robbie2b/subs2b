import { UserConfig, ProviderConfigItem } from './config';

export interface SubtitleQuery {
  type: string;
  id: string;
  imdbId: string | null;
  season: number | null;
  episode: number | null;
  kitsuId: string | null;
  extra?: Record<string, string | undefined>;
  /** search in every language (used to find timing references, not for the list shown to the player) */
  allLanguages?: boolean;
}

export interface RawSubtitleItem {
  id: string;
  provider: string;
  providerName: string;
  url: string;
  lang: string;
  release?: string;
  format?: 'srt' | 'vtt' | string;
  hearingImpaired?: boolean;
  /** forced / foreign-parts-only subtitle (only the lines in another language): must not be picked as the main one */
  forced?: boolean;
  /** machine translated / AI generated: usable, but a human translation is preferred */
  aiTranslated?: boolean;
  rating?: number;
  downloads?: number;
  /** true when the provider confirmed this subtitle was made for the exact video file (file hash match) */
  hashMatch?: boolean;
}

export interface ProviderLogEntry {
  providerId: string;
  durationMs: number;
  resultsCount: number;
  success: boolean;
  error?: string;
}

/** How one provider did during one search: used by the Debug page statistics */
export interface ProviderReport {
  id: string;
  name: string;
  ms: number;
  ok: boolean;
  count: number;
  error?: string;
}

export interface SearchOutcome {
  items: RawSubtitleItem[];
  /** true when the provider errored or timed out (an empty result is NOT a failure) */
  failed: boolean;
  error?: string;
}

export interface SubtitleProvider {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly requiresApiKey: boolean;
  readonly defaultEnabled: boolean;
  search(query: SubtitleQuery, context: ProviderContext): Promise<RawSubtitleItem[]>;
  searchWithStatus?(query: SubtitleQuery, context: ProviderContext): Promise<SearchOutcome>;
}

export interface ProviderContext {
  config: UserConfig;
  providerConfig: ProviderConfigItem;
  timeoutMs: number;
}
