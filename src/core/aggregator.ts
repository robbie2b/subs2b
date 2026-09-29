import { StremioSubtitle, StremioSubtitlesResponse } from '../types/stremio';
import { SubtitleQuery, RawSubtitleItem } from '../types/provider';
import { UserConfig } from '../types/config';
import { executeParallelSearch } from '../providers';
import { validateAndNormalizeLanguage, isLanguageWhitelisted } from '../utils/normalizer';
import { deduplicateSubtitles, prioritizeSubtitles } from '../utils/deduplicator';
import { globalSubtitleCache } from '../utils/cache';
import { Logger } from '../utils/logger';
import { rankSubtitles } from '../utils/scorer';
import { recordDebug, DebugTopEntry } from '../utils/debugLog';
import { isAllowedDownloadUrl, addonHostsOf } from '../proxy/subtitleProxy';

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

  if (!rawSubtitles) {
    rawSubtitles = await executeParallelSearch(query, config);
    globalSubtitleCache.set(cacheKey, rawSubtitles, config.cacheTtlMinutes);
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
    orderedItems = [...hashMatched, ...deduplicateSubtitles(others, 0.85, config.deduplicationStrategy || 'both')];
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
      providerBonus: { subsro: 8 }
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
    debugTop = ranked.details.slice(0, 12).map((d, i) => ({ rank: i + 1, ...d }));
  } catch (err) {
    Logger.error('Scoring failed, keeping provider order', err);
  }

  if (configId) {
    const rawByProvider: Record<string, number> = {};
    for (const r of rawSubtitles) rawByProvider[r.provider] = (rawByProvider[r.provider] || 0) + 1;
    recordDebug(configId, {
      at: new Date().toISOString(),
      id: query.id,
      extra: query.extra,
      rawTotal: rawSubtitles.length,
      rawByProvider,
      afterLanguage: whitelistedItems.length,
      afterDedup: afterDedupCount,
      dedupDropped,
      afterScoring: orderedItems.length,
      usedFilename: debugUsedFilename,
      scoringFallback: debugFallback,
      top: debugTop
    });
  }

  // All subtitles are always searched and scored; the limit only trims what is shown to the player
  const limit = config.maxSubtitles;
  if (limit > 0 && orderedItems.length > limit) {
    Logger.info(`Showing the best ${limit} of ${orderedItems.length} subtitles (limit set in the configuration)`);
    orderedItems = orderedItems.slice(0, limit);
  }

  const addonHosts = addonHostsOf(config);

  // Stremio treats the subtitle id as unique: never send the same id twice
  const usedIds = new Set<string>();
  const subtitles: StremioSubtitle[] = orderedItems.map(item => {
    let uniqueId = item.id;
    for (let n = 2; usedIds.has(uniqueId); n++) {
      uniqueId = `${item.id}-${n}`;
    }
    usedIds.add(uniqueId);

    let finalUrl = item.url;
    if (finalUrl.startsWith('/')) {
      finalUrl = `${baseUrl}${finalUrl}`;
    } else if (
      config.convertVttToSrt !== false &&
      configId &&
      (item.format === 'vtt' || /\.vtt($|\?)/i.test(finalUrl)) &&
      isAllowedDownloadUrl(finalUrl, addonHosts)
    ) {
      // WebVTT is converted to SRT by this server so the player applies its own subtitle size/position settings
      finalUrl = `${baseUrl}/${configId}/sub/convert.srt?url=${encodeURIComponent(finalUrl)}`;
    } else if (/\.zip($|\?)/i.test(finalUrl) && isAllowedDownloadUrl(finalUrl)) {
      // Archives from known subtitle sites go through /sub/proxy so the player receives plain subtitle text
      const ext = item.format === 'vtt' || finalUrl.toLowerCase().endsWith('.vtt') ? '.vtt' : '.srt';
      const safeBaseName = (item.release || item.id).replace(/[^a-zA-Z0-9._-]/g, '_');
      const safeFilename = safeBaseName.endsWith(ext) ? safeBaseName : `${safeBaseName}${ext}`;
      finalUrl = `${baseUrl}/sub/proxy?url=${encodeURIComponent(finalUrl)}&filename=${encodeURIComponent(safeFilename)}`;
    }

    return {
      id: uniqueId,
      lang: item.lang,
      url: finalUrl,
      title: item.release || `${item.providerName || item.provider} Subtitle`
    };
  });

  return { subtitles };
}
