import { UserConfig, PartialUserConfig, CustomAddonConfig } from '../types/config';
import { isUuid, configStorage } from '../storage/configStore';

export const DEFAULT_LOGO = '/assets/subs2b_logo.png';

export const DEFAULT_USER_CONFIG: UserConfig = {
  instanceName: 'subs2b',
  instanceDesc: 'Subtitle aggregator and organizer',
  instanceLogo: DEFAULT_LOGO,
  instanceVersion: 'v1.0.0',
  providers: {
    'opensubtitles': { enabled: false, apiKey: '' },
    'subdl': { enabled: false, apiKey: '' },
    'subsource': { enabled: false, apiKey: '' },
    'regielive': { enabled: false, apiKey: '' }
  },
  customAddons: [],
  providerPriority: [
    'opensubtitles',
    'subdl',
    'subsource',
    'regielive'
  ],
  languages: ['pob', 'por', 'eng'],
  allowUnknownLanguages: false,
  languageRemap: {
    'por': 'pob',
    'pt-br': 'pob',
    'pt': 'pob',
    'pt-pt': 'pob'
  },
  language_remapping: {
    'por': 'pob',
    'pt-br': 'pob',
    'pt': 'pob',
    'pt-pt': 'pob'
  },
  providerTimeoutMs: 6000,
  deduplication: true,
  deduplicationStrategy: 'both',
  maxSubtitles: 0,
  convertVttToSrt: true,
  subsync: true,
  cacheTtlMinutes: 30
};

/** Values saved by earlier versions (when the project was called AIOsubs) that are upgraded automatically */
function upgradeLegacyName(name: string): string {
  if (!/aio\s*sub(?:s|titles)/i.test(name)) return name;
  return name
    .replace(/aio\s*sub(?:s|titles)/gi, 'subs2b')
    .replace(/\s+/g, ' ')
    .trim()
    // "AIOSubs (subs2b)" -> "subs2b (subs2b)" -> "subs2b"
    .replace(/^subs2b\s*\(\s*subs2b\s*\)$/i, 'subs2b');
}
const LEGACY_LOGO = '/assets/AIOsubs_logo_wordmark.png';

/** Providers that work without a personal API key (a shared one is used) */
const KEY_OPTIONAL_PROVIDERS = ['regielive'];

/**
 * Decodes a configuration passed directly in the URL (base64 JSON). Kept for old install links;
 * configurations saved from the UI are looked up by UUID instead (see decodeUserConfigAsync).
 */
export function decodeUserConfig(encodedStr?: string | null): UserConfig {
  if (!encodedStr || encodedStr.trim() === '' || encodedStr === 'default') {
    return { ...DEFAULT_USER_CONFIG };
  }

  try {
    let jsonStr = '';
    let base64 = encodedStr.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
      base64 += '=';
    }

    try {
      jsonStr = Buffer.from(base64, 'base64').toString('utf8');
      JSON.parse(jsonStr);
    } catch {
      try {
        jsonStr = decodeURIComponent(encodedStr);
        JSON.parse(jsonStr);
      } catch {
        jsonStr = encodedStr;
      }
    }

    const parsed: PartialUserConfig = JSON.parse(jsonStr);
    return mergeWithDefaults(parsed);
  } catch {
    return { ...DEFAULT_USER_CONFIG };
  }
}

export async function decodeUserConfigAsync(encodedStr?: string | null): Promise<UserConfig> {
  if (!encodedStr || encodedStr.trim() === '' || encodedStr === 'default') {
    return { ...DEFAULT_USER_CONFIG };
  }

  if (isUuid(encodedStr)) {
    const stored = await configStorage.getConfigByUuidAsync(encodedStr);
    if (stored) {
      return mergeWithDefaults(stored);
    }
  }

  return decodeUserConfig(encodedStr);
}

function cleanText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

export function mergeWithDefaults(partial: PartialUserConfig): UserConfig {
  const customAddons: CustomAddonConfig[] = Array.isArray(partial.customAddons)
    ? partial.customAddons
        .filter((a): a is CustomAddonConfig => Boolean(a && typeof a === 'object' && typeof a.manifestUrl === 'string'))
        .map(item => {
          let timeoutVal = 20000;
          if (typeof item.timeout === 'number' && !isNaN(item.timeout)) {
            timeoutVal = Math.max(1000, Math.min(60000, Math.round(item.timeout)));
          } else if (typeof item.timeout === 'string' && !isNaN(parseInt(item.timeout, 10))) {
            timeoutVal = Math.max(1000, Math.min(60000, parseInt(item.timeout, 10)));
          }

          return {
            id: (item.id && String(item.id).trim()) || `addon-${Math.random().toString(36).substring(2, 8)}`,
            name: (item.name && String(item.name).trim()) || 'External Addon',
            manifestUrl: String(item.manifestUrl).trim(),
            enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
            logo: typeof item.logo === 'string' ? item.logo.trim() : undefined,
            description: typeof item.description === 'string' ? item.description.trim() : undefined,
            resources: Array.isArray(item.resources) ? item.resources : undefined,
            selectedResources: Array.isArray(item.selectedResources) ? item.selectedResources : undefined,
            configurable: typeof item.configurable === 'boolean' ? item.configurable : undefined,
            configurationURL: typeof item.configurationURL === 'string' ? item.configurationURL : undefined,
            timeout: timeoutVal
          };
        })
    : [];

  // Migration of provider ids used by older versions: opensubtitles-rest / opensubtitles-v3 -> opensubtitles,
  // and the removed addic7ed provider is dropped
  const providerPriority: string[] = [];
  if (Array.isArray(partial.providerPriority)) {
    for (const item of partial.providerPriority) {
      const mapped = item === 'opensubtitles-rest' || item === 'opensubtitles-v3' ? 'opensubtitles' : item;
      // addic7ed and the removed direct Subs.ro provider are dropped from saved priority lists
      if (mapped !== 'addic7ed' && mapped !== 'subsro' && !providerPriority.includes(mapped)) {
        providerPriority.push(mapped);
      }
    }
  }
  if (providerPriority.length === 0) {
    providerPriority.push(...DEFAULT_USER_CONFIG.providerPriority);
  }

  const rawRemap = (partial.language_remapping && typeof partial.language_remapping === 'object')
    ? partial.language_remapping
    : ((partial.languageRemap && typeof partial.languageRemap === 'object')
      ? partial.languageRemap
      : DEFAULT_USER_CONFIG.languageRemap);
  const cleanRemap: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawRemap)) {
    if (typeof v === 'string' && k.trim() && v.trim()) {
      cleanRemap[k.trim().toLowerCase()] = v.trim().toLowerCase();
    }
  }

  const name = cleanText(partial.instanceName, DEFAULT_USER_CONFIG.instanceName as string);
  const logo = cleanText(partial.instanceLogo, DEFAULT_LOGO);

  const result: UserConfig = {
    instanceName: upgradeLegacyName(name),
    instanceDesc: cleanText(partial.instanceDesc, DEFAULT_USER_CONFIG.instanceDesc as string),
    instanceLogo: logo === LEGACY_LOGO ? DEFAULT_LOGO : logo,
    instanceVersion: cleanText(partial.instanceVersion, DEFAULT_USER_CONFIG.instanceVersion as string),
    providers: {
      'opensubtitles': { enabled: false, apiKey: '' },
      'subdl': { enabled: false, apiKey: '' },
      'subsource': { enabled: false, apiKey: '' },
      'regielive': { enabled: false, apiKey: '' }
    },
    customAddons,
    providerPriority,
    languages: Array.isArray(partial.languages) && partial.languages.length > 0
      ? partial.languages.map(l => l.trim().toLowerCase())
      : [...DEFAULT_USER_CONFIG.languages],
    allowUnknownLanguages: typeof partial.allowUnknownLanguages === 'boolean'
      ? partial.allowUnknownLanguages
      : DEFAULT_USER_CONFIG.allowUnknownLanguages,
    languageRemap: cleanRemap,
    language_remapping: cleanRemap,
    providerTimeoutMs: typeof partial.providerTimeoutMs === 'number'
      ? Math.max(2000, Math.min(15000, partial.providerTimeoutMs))
      : DEFAULT_USER_CONFIG.providerTimeoutMs,
    deduplication: typeof partial.deduplication === 'boolean'
      ? partial.deduplication
      : DEFAULT_USER_CONFIG.deduplication,
    deduplicationStrategy: (partial.deduplicationStrategy === 'hash' || partial.deduplicationStrategy === 'fuzzy')
      ? partial.deduplicationStrategy
      : 'both',
    maxSubtitles: typeof partial.maxSubtitles === 'number' && isFinite(partial.maxSubtitles)
      ? Math.max(0, Math.min(200, Math.round(partial.maxSubtitles)))
      : DEFAULT_USER_CONFIG.maxSubtitles,
    convertVttToSrt: typeof partial.convertVttToSrt === 'boolean'
      ? partial.convertVttToSrt
      : DEFAULT_USER_CONFIG.convertVttToSrt,
    subsync: typeof partial.subsync === 'boolean'
      ? partial.subsync
      : DEFAULT_USER_CONFIG.subsync,
    cacheTtlMinutes: typeof partial.cacheTtlMinutes === 'number'
      ? Math.max(1, Math.min(1440, partial.cacheTtlMinutes))
      : DEFAULT_USER_CONFIG.cacheTtlMinutes
  };

  if (partial.providers && typeof partial.providers === 'object') {
    for (const [key, val] of Object.entries(partial.providers)) {
      if (!val || typeof val !== 'object') continue;

      const targetKey = key === 'opensubtitles-rest' || key === 'opensubtitles-v3' ? 'opensubtitles' : key;
      if (!result.providers[targetKey]) continue;

      // A provider can only be enabled when it has an API key (RegieLive works without one)
      const apiKey = typeof val.apiKey === 'string' ? val.apiKey.trim() : '';
      const keyOptional = KEY_OPTIONAL_PROVIDERS.includes(targetKey);
      result.providers[targetKey] = {
        enabled: (apiKey !== '' || keyOptional) && val.enabled === true,
        apiKey
      };
    }
  }

  return result;
}
