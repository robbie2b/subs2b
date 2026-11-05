export interface ProviderConfigItem {
  enabled: boolean;
  apiKey?: string;
}

export interface CustomAddonConfig {
  id: string;
  name: string;
  manifestUrl: string;
  enabled: boolean;
  logo?: string;
  description?: string;
  timeout?: number;
  resources?: string[];
  selectedResources?: string[];
  configurable?: boolean;
  configurationURL?: string;
}

export interface UserConfig {
  instanceName?: string;
  instanceDesc?: string;
  instanceLogo?: string;
  instanceVersion?: string;

  providers: Record<string, ProviderConfigItem>;
  customAddons: CustomAddonConfig[];

  providerPriority: string[];
  languages: string[];
  allowUnknownLanguages: boolean;
  languageRemap: Record<string, string>;
  language_remapping?: Record<string, string>;
  providerTimeoutMs: number;
  /**
   * Dynamic timeout: the search does not wait for the whole Connector timeout when something good has already arrived
   * (a hash match, an exact name match, or a score above `dynamicTimeoutScore`, with the sources the user ranks higher
   * already answered). The sources still running finish in the background and complete the saved list.
   */
  dynamicTimeout?: boolean;
  /** the score that counts as good enough for the dynamic timeout */
  dynamicTimeoutScore?: number;
  deduplication: boolean;
  deduplicationStrategy?: 'both' | 'hash' | 'fuzzy';

  /** Maximum number of subtitles shown to the player (0 = show all). Everything is still searched and scored. */
  maxSubtitles: number;

  /** Convert WebVTT subtitles to SRT before they reach the player (SRT respects the player's size/position settings) */
  convertVttToSrt: boolean;

  /** Automatic re-timing: when no subtitle fits the playing release, align them to a matching-release reference */
  subsync: boolean;

  cacheTtlMinutes: number;
}

export type PartialUserConfig = Partial<Omit<UserConfig, 'providers' | 'languageRemap' | 'language_remapping'>> & {
  providers?: Record<string, Partial<ProviderConfigItem>>;
  languageRemap?: Record<string, string>;
  language_remapping?: Record<string, string>;
};
