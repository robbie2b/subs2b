import { StremioSubtitle, StremioSubtitlesResponse } from '../types/stremio';
import { SubtitleQuery, RawSubtitleItem, ProviderReport } from '../types/provider';
import { UserConfig } from '../types/config';
import { executeParallelSearch } from '../providers';
import { validateAndNormalizeLanguage, isLanguageWhitelisted } from '../utils/normalizer';
import { deduplicateSubtitles, prioritizeSubtitles, copiesOf } from '../utils/deduplicator';
import { globalSubtitleCache } from '../utils/cache';
import { Logger } from '../utils/logger';
import { rankSubtitles } from '../utils/scorer';
import { recordDebug, DebugTopEntry } from '../utils/debugLog';
import { recordUsage } from '../storage/usageStore';
import { needsReference, fromFileGroup, archivePickParams as buildArchivePickParams } from './alignment';
import { encodeAlignedToken, encodeFallbackToken, AlignedToken, MAX_ALTERNATIVES, MAX_BACKUPS } from './alignedToken';
import { prepareAligned } from './alignedPrepare';
import { isAllowedDownloadUrl, addonHostsOf, serverCanDownload } from '../proxy/subtitleProxy';

/** The copy kept for a subtitle: itself, or its first backup this server can download when it cannot */
function preferDownloadable(item: RawSubtitleItem): RawSubtitleItem {
  if (!item.backups?.length || serverCanDownload(item)) return item;
  const k = item.backups.findIndex(b => serverCanDownload(b));
  if (k < 0) return item;
  const { backups, ...main } = item;
  const rest = backups.filter((_, i) => i !== k);
  // the copy stands for the same subtitle: an exact hash match stays one
  return { ...backups[k], ...(item.hashMatch ? { hashMatch: true } : {}), backups: [main, ...rest] };
}

/** How long an empty list, or one from a search where a provider failed, is kept (minutes; normal lists: cacheTtlMinutes) */
export const SHORT_CACHE_MINUTES = 2;

/** How many rejected subtitles a request keeps for Debug (besides the best 12) */
const MAX_REJECTED_IN_DEBUG = 60;

/** How many languages get their first subtitle aligned in advance */
const MAX_PREPARED_LANGUAGES = 2;

function toNumberOrNull(value: string | undefined): number | null {
  const n = parseInt(value ?? '', 10);
  return isNaN(n) ? null : n;
}

/** Turns a Stremio content id ("tt123", "tt123:1:2", "kitsu:99:3") into a structured query */
export function parseSubtitleQuery(
  type: string,
  id: string,
  extra?: Record<string, string | undefined>
): SubtitleQuery {
  const toImdb = (raw: string): string => (raw.startsWith('tt') ? raw : /^\d+$/.test(raw) ? `tt${raw}` : raw);

  let imdbId: string | null = null;
  let season: number | null = null;
  let episode: number | null = null;
  let kitsuId: string | null = null;

  const parts = id.split(':');
  if (parts[0] === 'kitsu') {
    kitsuId = `${parts[0]}:${parts[1]}`;
    episode = toNumberOrNull(parts[2]);
  } else {
    imdbId = toImdb(parts[0]);
    if (parts.length >= 2) {
      season = toNumberOrNull(parts[1]);
      episode = toNumberOrNull(parts[2]);
    }
  }

  return { type, id, imdbId, season, episode, kitsuId, extra };
}

export async function getAggregatedSubtitles(
  query: SubtitleQuery,
  config: UserConfig,
  baseUrl: string,
  configId?: string
): Promise<StremioSubtitlesResponse> {
  const enabledProviderIds = Object.keys(config.providers).filter(
    id => config.providers[id]?.enabled !== false
  );

  // The file hash changes which OpenSubtitles results are flagged as exact matches, so it is part of the key
  const cacheKey = globalSubtitleCache.generateKey(
    query.extra?.videoHash ? `${query.id}|h${query.extra.videoHash}` : query.id,
    config.languages,
    enabledProviderIds,
    query.season,
    query.episode
  );

  let rawSubtitles = globalSubtitleCache.get(cacheKey);
  const providerReport: ProviderReport[] = [];
  const fromCache = !!rawSubtitles;
  let incomplete = fromCache && globalSubtitleCache.isIncomplete(cacheKey);

  if (!rawSubtitles) {
    rawSubtitles = await executeParallelSearch(query, config, providerReport);
    // a search where a provider failed or timed out is kept only briefly: asked again soon, that provider may answer
    // (an empty answer is not a failure)
    const failedProviders = providerReport.filter(r => !r.ok);
    incomplete = failedProviders.length > 0;
    globalSubtitleCache.set(cacheKey, rawSubtitles, incomplete ? SHORT_CACHE_MINUTES : config.cacheTtlMinutes, incomplete);
    if (incomplete) {
      Logger.info(`[CACHE] kept ${SHORT_CACHE_MINUTES} min only: ${failedProviders.map(r => r.name).join(', ')} failed or timed out`);
    }
  } else {
    Logger.info(`Serving subtitles from cache for ${query.id} (${rawSubtitles.length} items)`);
  }

  Logger.info(`Request ${query.id}`, {
    filename: query.extra?.filename,
    videoHash: query.extra?.videoHash,
    found: rawSubtitles.length
  });

  // Canonicalize language codes to ISO 639-2 and drop unsupported codes to avoid player issues
  const activeRemap = config.language_remapping || config.languageRemap;
  const normalizedItems: RawSubtitleItem[] = [];
  const unknownLanguages = new Set<string>();

  for (const sub of rawSubtitles) {
    const validation = validateAndNormalizeLanguage(sub.lang, config.allowUnknownLanguages, activeRemap);
    if (!validation.valid || !validation.normalizedLang) {
      unknownLanguages.add(String(sub.lang));
      continue;
    }
    normalizedItems.push({ ...sub, lang: validation.normalizedLang });
  }

  if (unknownLanguages.size > 0) {
    Logger.info(
      `Ignored ${rawSubtitles.length - normalizedItems.length} subtitle(s) with unrecognized language codes: ${[...unknownLanguages].join(', ')}`
    );
  }

  const effectiveWhitelist = (config.languages && config.languages.length > 0)
    ? config.languages
    : ['pob', 'eng'];

  const whitelistedItems = normalizedItems.filter(item =>
    isLanguageWhitelisted(item.lang, effectiveWhitelist)
  );

  Logger.info(`Language filter: ${rawSubtitles.length} -> ${whitelistedItems.length} subtitles`, {
    whitelist: effectiveWhitelist
  });

  let orderedItems = prioritizeSubtitles(whitelistedItems, config.providerPriority);
  const beforeDedupItems = orderedItems;

  if (config.deduplication) {
    // Exact file-hash matches must never be merged away as "duplicates" of a similar release
    const hashMatched = orderedItems.filter(i => i.hashMatch === true);
    const others = orderedItems.filter(i => i.hashMatch !== true);
    // of the copies of one subtitle the one kept is the first this server can download (Subsync needs the file):
    // a copy from a source refusing this server for now gives its place to a working backup
    // (a hash match keeps its place, but its copies from other providers become its download backups too)
    const hashWithBackups = hashMatched.map(h => {
      const copies = copiesOf(h, others);
      return copies.length ? preferDownloadable({ ...h, backups: copies }) : h;
    });
    orderedItems = [...hashWithBackups, ...deduplicateSubtitles(others, 0.85, config.deduplicationStrategy || 'both').map(preferDownloadable)];
    Logger.info(
      `Deduplication: ${beforeDedupItems.length} -> ${orderedItems.length} subtitles${hashMatched.length ? ` (${hashMatched.length} hash match)` : ''}`
    );
  }

  const afterDedupCount = orderedItems.length;
  const keptIds = new Set(orderedItems.map(i => i.id));
  const dedupDropped = beforeDedupItems
    .filter(i => !keptIds.has(i.id))
    .map(i => ({ provider: i.provider, release: i.release || '' }));
  let debugTop: DebugTopEntry[] = [];
  let debugUsedFilename = false;
  let debugFallback = false;

  // Bazarr-style scoring: best match for the playing file goes first (players auto-pick position 1)
  try {
    const ranked = rankSubtitles(orderedItems, {
      filename: query.extra?.filename,
      season: query.season,
      episode: query.episode,
      providerBonus: { subsro: 8 },
      providerPriority: config.providerPriority
    });
    Logger.info(
      `Scoring: ${orderedItems.length} -> ${ranked.items.length} subtitles (filename: ${ranked.usedFilename ? 'yes' : 'no'}${ranked.fallback ? ', fallback' : ''})`
    );
    ranked.details.slice(0, 5).forEach((d, i) => {
      Logger.info(`[SCORE] #${i + 1} ${d.score}${d.rejected ? ' REJECTED' : ''} [${d.provider}] ${d.release} | ${d.reasons.join(', ')}`);
    });
    orderedItems = ranked.items;
    debugUsedFilename = ranked.usedFilename;
    debugFallback = ranked.fallback;
    // the best 12, and every rejected subtitle (with the reason), so Debug shows why something was left out
    debugTop = ranked.details.map((d, i) => ({ rank: i + 1, ...d }))
      .filter((d, i) => i < 12 || d.rejected).slice(0, 12 + MAX_REJECTED_IN_DEBUG);
  } catch (err) {
    Logger.error('Scoring failed, keeping provider order', err);
  }

  // Subsync: the links of subtitles not made by the playing file's group go through the aligning endpoint, which
  // checks them against references of the file's own kind and re-times them when needed
  const subsyncVerdict = config.subsync !== false && configId
    ? needsReference(query.extra?.filename, orderedItems)
    : { needed: false, reason: configId ? 'subsync is switched off' : 'no configuration id' };
  // A subtitle whose only link goes through this server to a source refusing it (an OpenSubtitles quota reached)
  // cannot be downloaded by anyone, player included: it goes last, whatever its score
  const dead = orderedItems.filter(i => i.url.startsWith('/') && !serverCanDownload(i));
  if (dead.length) {
    orderedItems = [...orderedItems.filter(i => !dead.includes(i)), ...dead];
    Logger.info(`[SOURCES] ${dead.length} subtitle(s) moved last: their source refuses this server for now and they have no working copy`);
  }

  if (subsyncVerdict.needed) {
    Logger.info(`[SUBSYNC] a timing reference is needed: ${subsyncVerdict.reason}`);
    // A subtitle this server cannot download cannot be checked: it goes after the ones that can (the player picks
    // the first), still offered to be chosen by hand
    const filename = query.extra?.filename;
    const unreachable = orderedItems.filter(i => !fromFileGroup(filename, i.release) && !serverCanDownload(i));
    if (unreachable.length) {
      orderedItems = [...orderedItems.filter(i => !unreachable.includes(i)), ...unreachable];
      Logger.info(`[SUBSYNC] ${unreachable.length} subtitle(s) moved down: their source refuses this server for now, they cannot be checked`);
    }
  }

  // All subtitles are always searched and scored; the limit only trims what is shown to the player
  const afterScoringCount = orderedItems.length;
  const limit = config.maxSubtitles;
  if (limit > 0 && orderedItems.length > limit) {
    Logger.info(`Showing the best ${limit} of ${orderedItems.length} subtitles (limit set in the configuration)`);
    orderedItems = orderedItems.slice(0, limit);
  }

  if (configId) {
    const rawByProvider: Record<string, number> = {};
    for (const r of rawSubtitles) rawByProvider[r.provider] = (rawByProvider[r.provider] || 0) + 1;
    const record = {
      rawTotal: rawSubtitles.length,
      rawByProvider,
      afterLanguage: whitelistedItems.length,
      afterDedup: afterDedupCount,
      afterScoring: afterScoringCount,
      shown: orderedItems.length,
      usedFilename: debugUsedFilename,
      scoringFallback: debugFallback,
      subsync: { triggered: subsyncVerdict.needed, reason: subsyncVerdict.reason },
      top: debugTop,
      // timings exist only for searches that really ran (a cached answer did not ask the providers again)
      ...(fromCache ? { cached: true } : { providers: providerReport })
    };
    recordDebug(configId, {
      at: new Date().toISOString(),
      id: query.id,
      extra: query.extra,
      dedupDropped,
      ...record
    });
    // The same summary is stored with the usage timeline, so the Debug page can show it for older requests too
    void recordUsage(configId, { id: query.id, type: query.type, filename: query.extra?.filename, details: record });
  }

  const addonHosts = addonHostsOf(config);
  const archivePickParams = buildArchivePickParams(query);

  /** The link the player (or this server) downloads a subtitle from */
  const linkOf = (item: RawSubtitleItem): string => {
    let finalUrl = item.url;
    if (finalUrl.startsWith('/')) {
      // Archive downloads also learn what is being played, to pick the right file inside a season pack
      if (finalUrl.startsWith('/sub/proxy?')) finalUrl += archivePickParams;
      finalUrl = `${baseUrl}${finalUrl}`;
    } else if (
      config.convertVttToSrt !== false &&
      configId &&
      (item.format === 'vtt' || /\.vtt($|\?)/i.test(finalUrl)) &&
      isAllowedDownloadUrl(finalUrl, addonHosts)
    ) {
      // WebVTT is converted to SRT by this server so the player applies its own subtitle size/position settings
      // The link must END in .srt: players guess the format from the end of the link (a trailing ".vtt" makes them
      // parse the converted SRT as WebVTT and drop it), so the original address is carried inside the path
      finalUrl = `${baseUrl}/${configId}/sub/convert/${Buffer.from(finalUrl).toString('base64url')}.srt`;
    } else if (/\.zip($|\?)/i.test(finalUrl) && isAllowedDownloadUrl(finalUrl)) {
      // Archives from known subtitle sites go through /sub/proxy so the player receives plain subtitle text
      const ext = item.format === 'vtt' || finalUrl.toLowerCase().endsWith('.vtt') ? '.vtt' : '.srt';
      const safeBaseName = (item.release || item.id).replace(/[^a-zA-Z0-9._-]/g, '_');
      const safeFilename = safeBaseName.endsWith(ext) ? safeBaseName : `${safeBaseName}${ext}`;
      finalUrl = `${baseUrl}/sub/proxy?url=${encodeURIComponent(finalUrl)}&filename=${encodeURIComponent(safeFilename)}${archivePickParams}`;
    }
    return finalUrl;
  };
  /** Links this server may download itself (its own, a subtitle site or an addon of this configuration) */
  const fetchable = (u: string): boolean => u.startsWith(baseUrl + '/') || isAllowedDownloadUrl(u, addonHosts);

  // Stremio treats the subtitle id as unique: never send the same id twice
  const usedIds = new Set<string>();
  const subtitles: StremioSubtitle[] = orderedItems.map(item => {
    let uniqueId = item.id;
    for (let n = 2; usedIds.has(uniqueId); n++) {
      uniqueId = `${item.id}-${n}`;
    }
    usedIds.add(uniqueId);

    return {
      id: uniqueId,
      lang: item.lang,
      url: linkOf(item),
      title: item.release || `${item.providerName || item.provider} Subtitle`
    };
  });

  // The same subtitle from other providers (merged by deduplication): tried in order when the first cannot be downloaded
  const directUrls = subtitles.map(s => s.url);
  const backups = orderedItems.map((item, idx) => fetchable(directUrls[idx])
    ? (item.backups || []).map(linkOf).filter(u => u !== directUrls[idx] && fetchable(u)).slice(0, MAX_BACKUPS)
    : []);
  const viaServer = new Set<number>();

  // Aligned: the player asks this server, which re-times the subtitle before sending it (only our own or allowed links).
  // Each link also carries the next subtitles of the same language: when it does not fit the references, the first
  // alternative that does is served instead.
  if (subsyncVerdict.needed && configId && query.extra?.filename) {
    const filename = query.extra.filename;
    const alignable = directUrls.map(fetchable);
    const firstOfLanguage = new Map<string, AlignedToken>();
    subtitles.forEach((sub, idx) => {
      // a subtitle from the file's own release group is trusted and served directly
      if (!alignable[idx] || fromFileGroup(filename, orderedItems[idx].release)) return;
      const alternatives: Array<{ u: string; r?: string; b?: string[] }> = [];
      for (let j = idx + 1; j < subtitles.length && alternatives.length < MAX_ALTERNATIVES; j++) {
        if (alignable[j] && orderedItems[j].lang === orderedItems[idx].lang) {
          alternatives.push({ u: directUrls[j], r: orderedItems[j].release, ...(backups[j].length ? { b: backups[j] } : {}) });
        }
      }
      const token: AlignedToken = {
        u: directUrls[idx], id: query.id, t: query.type, f: filename, r: orderedItems[idx].release,
        ...(backups[idx].length ? { b: backups[idx] } : {}),
        ...(alternatives.length ? { a: alternatives } : {})
      };
      if (!firstOfLanguage.has(orderedItems[idx].lang)) firstOfLanguage.set(orderedItems[idx].lang, token);
      sub.url = `${baseUrl}/${configId}/sub/aligned/${encodeAlignedToken(token)}.srt`;
      viaServer.add(idx);
    });

    // The player usually picks the first subtitle of the language: its alignment starts now, while the video is
    // still opening (several seconds), so the subtitle is ready, or nearly, when the player asks for it
    const prepQuery = parseSubtitleQuery(query.type, query.id, { filename });
    for (const token of [...firstOfLanguage.values()].slice(0, MAX_PREPARED_LANGUAGES)) {
      prepareAligned(token, prepQuery, config, baseUrl);
    }
  }

  // The other subtitles with backups go through this server too, which tries the sources in order
  if (configId) {
    subtitles.forEach((sub, idx) => {
      if (viaServer.has(idx) || backups[idx].length === 0) return;
      const token = encodeFallbackToken({ u: directUrls[idx], b: backups[idx], r: orderedItems[idx].release });
      sub.url = `${baseUrl}/${configId}/sub/fallback/${token}.srt`;
    });
  }

  // the player keeps the list as long as this server does; an empty or incomplete list only briefly
  const short = incomplete || subtitles.length === 0;
  if (short && !incomplete) Logger.info(`[CACHE] kept ${SHORT_CACHE_MINUTES} min only: no subtitle in your languages`);
  return { subtitles, cacheMaxAge: short ? SHORT_CACHE_MINUTES * 60 : Math.round(config.cacheTtlMinutes * 60) };
}
