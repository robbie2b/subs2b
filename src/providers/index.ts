import { SubtitleProvider, SubtitleQuery, RawSubtitleItem, ProviderContext, SearchOutcome, ProviderReport } from '../types/provider';
import { UserConfig } from '../types/config';
import { OpenSubtitlesProvider } from './openSubtitles';
import { SubDLProvider } from './subdl';
import { SubsourceProvider } from './subsource';
import { RegieLiveProvider } from './regielive';
import { PodnapisiProvider } from './podnapisi';
import { GenericStremioAddonProvider } from './genericStremioAddon';
import { Logger } from '../utils/logger';
import { ENV } from '../config/env';

const BUILTIN_PROVIDERS: SubtitleProvider[] = [
  new OpenSubtitlesProvider(),
  new SubDLProvider(),
  new SubsourceProvider(),
  new RegieLiveProvider(),
  new PodnapisiProvider()
];

function isOpenSubtitlesAddon(id: string, name: string): boolean {
  return /opensubtitles/i.test(`${id} ${name}`);
}

export function getAllProviders(): SubtitleProvider[] {
  return [...BUILTIN_PROVIDERS];
}

export async function executeParallelSearch(
  query: SubtitleQuery,
  config: UserConfig,
  report?: ProviderReport[]
): Promise<RawSubtitleItem[]> {
  const activeProviders: SubtitleProvider[] = BUILTIN_PROVIDERS.filter(provider => {
    const provConfig = config.providers[provider.id];
    if (!provConfig || provConfig.enabled === false) {
      return false;
    }
    if (provider.requiresApiKey && (!provConfig.apiKey || provConfig.apiKey.trim() === '')) {
      return false;
    }
    return true;
  });

  // OPENSUBTITLES_ADDON_MODE=fallback: when the direct OpenSubtitles integration is active, OpenSubtitles
  // addons are used ONLY as a fallback (they run after it, and only if it failed: error / timeout).
  // Default "parallel": they run together with it and deduplication merges the results.
  const directOpenSubtitlesActive =
    ENV.OPENSUBTITLES_ADDON_MODE === 'fallback' && activeProviders.some(p => p.id === 'opensubtitles');
  const fallbackProviders: SubtitleProvider[] = [];

  if (Array.isArray(config.customAddons)) {
    for (const custom of config.customAddons) {
      if (custom && custom.enabled !== false && custom.manifestUrl) {
        if (Array.isArray(custom.selectedResources) && !custom.selectedResources.includes('subtitles')) {
          continue;
        }
        const addonProvider = new GenericStremioAddonProvider(custom.id, custom.name, custom.manifestUrl);
        if (directOpenSubtitlesActive && isOpenSubtitlesAddon(custom.id, custom.name)) {
          fallbackProviders.push(addonProvider);
        } else {
          activeProviders.push(addonProvider);
        }
      }
    }
  }

  Logger.info(`Searching subtitles across ${activeProviders.length} providers`, {
    id: query.id,
    imdbId: query.imdbId,
    type: query.type,
    season: query.season,
    episode: query.episode,
    providers: activeProviders.map(p => `${p.name} (${p.id})`),
    timeoutMs: config.providerTimeoutMs
  });

  const runProvider = (provider: SubtitleProvider): Promise<SearchOutcome> => {
    const customConfig = config.customAddons?.find(c => c.id === provider.id);
    const timeoutMs = (customConfig && typeof customConfig.timeout === 'number' && customConfig.timeout > 0)
      ? customConfig.timeout
      : config.providerTimeoutMs;

    const context: ProviderContext = {
      config,
      providerConfig: config.providers[provider.id] || { enabled: true },
      timeoutMs
    };
    if (provider.searchWithStatus) {
      return provider.searchWithStatus(query, context);
    }
    return provider.search(query, context).then(items => ({ items, failed: false }));
  };

  // Same as runProvider, but also notes how long the provider took and whether it worked
  const runTimed = async (provider: SubtitleProvider): Promise<SearchOutcome> => {
    const started = Date.now();
    try {
      const outcome = await runProvider(provider);
      report?.push({
        id: provider.id,
        name: provider.name,
        ms: Date.now() - started,
        ok: !outcome.failed,
        count: outcome.items.length,
        error: outcome.error
      });
      return outcome;
    } catch (err) {
      report?.push({
        id: provider.id,
        name: provider.name,
        ms: Date.now() - started,
        ok: false,
        count: 0,
        error: err instanceof Error ? err.message : String(err)
      });
      throw err;
    }
  };

  const settledResults = await Promise.allSettled(activeProviders.map(runTimed));
  const aggregatedSubtitles: RawSubtitleItem[] = [];
  let directFailed = false;

  settledResults.forEach((result, idx) => {
    const provider = activeProviders[idx];
    if (result.status === 'fulfilled') {
      aggregatedSubtitles.push(...result.value.items);
      if (provider.id === 'opensubtitles' && result.value.failed) {
        directFailed = true;
      }
    } else {
      Logger.error(`Provider [${provider.id}] search promise rejected`, result.reason);
      if (provider.id === 'opensubtitles') {
        directFailed = true;
      }
    }
  });

  if (fallbackProviders.length > 0) {
    if (directFailed) {
      Logger.warn(`[FALLBACK] Direct OpenSubtitles failed -> using addon(s): ${fallbackProviders.map(p => p.id).join(', ')}`);
      const fallbackResults = await Promise.allSettled(fallbackProviders.map(runTimed));
      for (const result of fallbackResults) {
        if (result.status === 'fulfilled') {
          aggregatedSubtitles.push(...result.value.items);
        }
      }
    } else {
      Logger.info(`[FALLBACK] Direct OpenSubtitles ok -> addon(s) not used: ${fallbackProviders.map(p => p.id).join(', ')}`);
    }
  }

  return aggregatedSubtitles;
}
