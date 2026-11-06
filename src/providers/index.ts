import { SubtitleProvider, SubtitleQuery, RawSubtitleItem, ProviderContext, SearchOutcome, ProviderReport } from '../types/provider';
import { UserConfig } from '../types/config';
import { OpenSubtitlesProvider } from './openSubtitles';
import { SubDLProvider } from './subdl';
import { SubsourceProvider } from './subsource';
import { RegieLiveProvider } from './regielive';
import { TitrariProvider } from './titrari';
import { SubsroDirectProvider } from './subsroDirect';
import { SubtitrariNoiProvider } from './subtitrariNoi';
import { YifyProvider } from './yify';
import { Addic7edProvider } from './addic7ed';
import { WyzieProvider } from './wyzie';
import { GenericStremioAddonProvider } from './genericStremioAddon';
import { Logger } from '../utils/logger';
import { keepAlive } from '../utils/background';
import { activity, filmLabel, fmtMs } from '../utils/activity';
import { ENV } from '../config/env';

const BUILTIN_PROVIDERS: SubtitleProvider[] = [
  new OpenSubtitlesProvider(),
  new SubDLProvider(),
  new SubsourceProvider(),
  new RegieLiveProvider(),
  new SubsroDirectProvider(),
  new TitrariProvider(),
  new SubtitrariNoiProvider(),
  new YifyProvider(),
  new Addic7edProvider(),
  new WyzieProvider()
];

function isOpenSubtitlesAddon(id: string, name: string): boolean {
  return /opensubtitles/i.test(`${id} ${name}`);
}

export function getAllProviders(): SubtitleProvider[] {
  return [...BUILTIN_PROVIDERS];
}

/** The dynamic timeout: when is what has arrived enough, so the sources still running need not be waited for */
export interface EarlyStop {
  /** `pending` = the ids of the sources that have not answered yet */
  isEnough(items: RawSubtitleItem[], pending: string[]): boolean;
  /** how long to go on after "enough", for sources about to answer */
  graceMs: number;
  /** ask again every `everyMs` for the first `forMs` of the search, even if no source has answered since (the judgement depends on time) */
  recheck?: { everyMs: number; forMs: number };
}

export interface SearchOptions {
  earlyStop?: EarlyStop;
  /** called with the complete list when the sources left running have finished, if the search stopped early */
  onFullResult?: (items: RawSubtitleItem[]) => void;
  /** tells the caller whether the search stopped early (the list is then not complete) */
  outcome?: { stoppedEarly: boolean };
  /** called with everything that has arrived so far, each time a source answers */
  onProgress?: (items: RawSubtitleItem[]) => void;
}

export async function executeParallelSearch(
  query: SubtitleQuery,
  config: UserConfig,
  report?: ProviderReport[],
  options: SearchOptions = {}
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

  // (the searches for timing references are not shown as such: Subsync reports them in its own words)
  const film = filmLabel(query.id, query.extra?.filename);
  const shown = !query.allLanguages;
  if (shown) activity('search', film, `Searching ${activeProviders.length} sources: ${activeProviders.map(p => p.name).join(', ')}`, { step: 'search', state: 'start', sources: activeProviders.map(p => p.name) });

  const runProvider = (provider: SubtitleProvider): Promise<SearchOutcome> => {
    // One limit for everything, the Connector timeout (Filters → Results): the native services and the imported addons
    // alike. An imported addon used to keep its own timeout (20 s when imported), so one slow addon (opensubtitles PRO)
    // held the whole list for up to 20 s, which is also where Nuvio gives up on an addon.
    const timeoutMs = config.providerTimeoutMs;

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

  // Same as runProvider, but also notes how long the provider took and whether it worked. A provider that was not
  // waited for (dynamic timeout) has a placeholder entry in the report: its real answer replaces it when it comes.
  const waivedEntries = new Map<string, ProviderReport>();
  const note = (provider: SubtitleProvider, entry: ProviderReport): void => {
    const waived = waivedEntries.get(provider.id);
    if (waived) Object.assign(waived, entry, { waived: undefined });
    else report?.push(entry);
    if (shown) {
      activity('source', film, entry.ok
        ? `${entry.name}: ${entry.count} subtitle${entry.count === 1 ? '' : 's'} in ${fmtMs(entry.ms)}${waived ? ' (answered after the list was sent)' : ''}`
        : `${entry.name} failed after ${fmtMs(entry.ms)}${entry.error ? ` (${entry.error.replace(/^Error: /, '').slice(0, 80)})` : ''}`,
      { src: { name: entry.name, state: entry.ok ? (waived ? 'late' : 'ok') : 'fail', ms: entry.ms, count: entry.count, error: entry.ok ? undefined : (entry.error || 'failed').replace(/^Error: /, '').slice(0, 80) } });
    }
  };
  const runTimed = async (provider: SubtitleProvider): Promise<SearchOutcome> => {
    const started = Date.now();
    try {
      const outcome = await runProvider(provider);
      note(provider, {
        id: provider.id,
        name: provider.name,
        ms: Date.now() - started,
        ok: !outcome.failed,
        count: outcome.items.length,
        error: outcome.error
      });
      return outcome;
    } catch (err) {
      note(provider, {
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

  const searchStarted = Date.now();
  const itemsOf = new Map<number, RawSubtitleItem[]>();
  const pending = new Set<number>(activeProviders.map((_, i) => i));
  let directFailed = false;
  // what has arrived so far, in the order of the providers
  const gather = (): RawSubtitleItem[] => [...itemsOf.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, items]) => items);

  // (the fallback mode of OpenSubtitles needs every answer: no early stop then)
  const early = options.earlyStop && fallbackProviders.length === 0 && activeProviders.length > 1 ? options.earlyStop : null;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let stopEarly: () => void = () => undefined;
  const earlyPromise = new Promise<'early'>(resolve => { stopEarly = () => resolve('early'); });

  const check = (): void => {
    if (!early || graceTimer || pending.size === 0) return;
    let enough = false;
    try {
      enough = early.isEnough(gather(), [...pending].map(i => activeProviders[i].id));
    } catch (err) {
      Logger.error('Dynamic timeout check failed', err);
    }
    if (enough) graceTimer = setTimeout(() => stopEarly(), early.graceMs);
  };

  const recheckTimer = early && early.recheck ? setInterval(check, early.recheck.everyMs) : undefined;
  const recheckEnd = early && early.recheck ? setTimeout(() => { if (recheckTimer) clearInterval(recheckTimer); }, early.recheck.forMs) : undefined;

  const all = Promise.allSettled(activeProviders.map((provider, idx) =>
    runTimed(provider).then(
      outcome => {
        itemsOf.set(idx, outcome.items);
        if (provider.id === 'opensubtitles' && outcome.failed) directFailed = true;
      },
      err => {
        Logger.error(`Provider [${provider.id}] search promise rejected`, err);
        if (provider.id === 'opensubtitles') directFailed = true;
      }
    ).finally(() => {
      pending.delete(idx);
      if (options.onProgress) {
        try { options.onProgress(gather()); } catch (err) { Logger.error('Search progress callback failed', err); }
      }
      check();
    })
  ));

  const winner = early ? await Promise.race([all.then(() => 'all' as const), earlyPromise]) : (await all, 'all' as const);
  if (graceTimer) clearTimeout(graceTimer);
  if (recheckTimer) clearInterval(recheckTimer);
  if (recheckEnd) clearTimeout(recheckEnd);

  if (winner === 'early') {
    const waived = [...pending].map(i => activeProviders[i]);
    for (const provider of waived) {
      const entry: ProviderReport = {
        id: provider.id, name: provider.name, ms: Date.now() - searchStarted, ok: true, count: 0,
        error: 'not waited for: something good had already arrived', waived: true
      };
      waivedEntries.set(provider.id, entry);
      report?.push(entry);
    }
    if (options.outcome) options.outcome.stoppedEarly = true;
    Logger.info(`[DYNAMIC] stopped waiting after ${Date.now() - searchStarted} ms; still running in the background: ${waived.map(p => p.name).join(', ')}`);
    if (shown) activity('search', film, `Stopped waiting after ${fmtMs(Date.now() - searchStarted)}: not waiting for ${waived.map(p => p.name).join(', ')} (they go on in the background)`, { step: 'search', state: 'done', ms: Date.now() - searchStarted, waived: waived.map(p => p.name) });
    const items = gather();
    // the sources left running finish in the background (kept alive on Vercel) and complete the saved list
    keepAlive(all.then(() => options.onFullResult?.(gather())));
    return items;
  }

  const aggregatedSubtitles: RawSubtitleItem[] = gather();
  if (shown) activity('search', film, `All ${activeProviders.length} sources answered after ${fmtMs(Date.now() - searchStarted)}: ${aggregatedSubtitles.length} subtitles found`, { step: 'search', state: 'done', ms: Date.now() - searchStarted });

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
