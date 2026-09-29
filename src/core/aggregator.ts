import { StremioSubtitle, StremioSubtitlesResponse } from '../types/stremio';
import { SubtitleQuery, RawSubtitleItem } from '../types/provider';
import { UserConfig } from '../types/config';
import { executeParallelSearch } from '../providers';
import { validateAndNormalizeLanguage, isLanguageWhitelisted } from '../utils/normalizer';
import { deduplicateSubtitles, prioritizeSubtitles } from '../utils/deduplicator';
import { globalSubtitleCache } from '../utils/cache';
import { Logger } from '../utils/logger';
import { rankSubtitles } from '../utils/scorer';

// Temporary inspector helper: URL path only, first segment (may hold a key) masked, query string dropped
function inspectorPath(rawUrl: string): string {
  try {
    const segs = new URL(rawUrl, 'http://x').pathname.split('/').filter(Boolean);
    return segs.map((s, i) => (i === 0 && s.length > 16 ? s.slice(0, 4) + '...' : s.slice(0, 90))).join('/');
  } catch {
    return '';
  }
}

export function parseSubtitleQuery(
  type: string,
  id: string,
  extra?: Record<string, string | undefined>
): SubtitleQuery {
  let imdbId: string | null = null;
  let season: number | null = null;
  let episode: number | null = null;
  let kitsuId: string | null = null;

  if (id.includes(':')) {
    const parts = id.split(':');
    if (parts[0].startsWith('tt')) {
      imdbId = parts[0];
      season = parseInt(parts[1], 10);
      episode = parseInt(parts[2], 10);
    } else if (parts[0] === 'kitsu') {
      kitsuId = `${parts[0]}:${parts[1]}`;
      episode = parseInt(parts[2], 10);
    } else {
      imdbId = parts[0].startsWith('tt') ? parts[0] : (parts[0].match(/^\d+$/) ? `tt${parts[0]}` : parts[0]);
      if (parts.length >= 3) {
        season = parseInt(parts[1], 10);
        episode = parseInt(parts[2], 10);
      }
    }
  } else {
    imdbId = id.startsWith('tt') ? id : (id.match(/^\d+$/) ? `tt${id}` : id);
  }

  return {
    type,
    id,
    imdbId,
    season: isNaN(Number(season)) ? null : season,
    episode: isNaN(Number(episode)) ? null : episode,
    kitsuId,
    extra
  };
}

export async function getAggregatedSubtitles(
  query: SubtitleQuery,
  config: UserConfig,
  baseUrl: string
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

  // Inspector: id + extra (filename/videoHash) per request; set DEBUG_INSPECTOR=1 to also list every raw subtitle
  try {
    console.log('[INSPECTOR] id=' + query.id + ' extra=' + JSON.stringify(query.extra));
    console.log('[INSPECTOR] total=' + rawSubtitles.length);
    for (const s of (process.env.DEBUG_INSPECTOR === '1' ? rawSubtitles : [])) {
      console.log('[INSPECTOR] ' + JSON.stringify({
        provider: s.provider,
        lang: s.lang,
        release: s.release,
        format: s.format,
        hi: s.hearingImpaired,
        fps: s.fps,
        rating: s.rating,
        downloads: s.downloads,
        path: inspectorPath(s.url)
      }));
    }
  } catch (e) {
    console.log('[INSPECTOR] eroare la afisare:', e);
  }
  // ===== SFARSIT INSPECTOR =====

  // Canonicalize language codes to ISO 639-2 and drop unsupported codes to avoid player issues
  const normalizedItems: RawSubtitleItem[] = [];

  for (const sub of rawSubtitles) {
    const item: RawSubtitleItem = { ...sub };
    const activeRemap = config.language_remapping || config.languageRemap;
    const validation = validateAndNormalizeLanguage(
      item.lang,
      config.allowUnknownLanguages,
      activeRemap
    );

    if (!validation.valid || !validation.normalizedLang) {
      Logger.warn(`Discarded subtitle due to invalid ISO 639-2 language: "${item.lang}" from provider [${item.provider}]`, {
        provider: item.providerName || item.provider,
        release: item.release,
        reason: validation.discardedReason
      });
      continue;
    }

    item.lang = validation.normalizedLang;
    normalizedItems.push(item);
  }

  Logger.info(`Language validation (ISO 639-2): ${rawSubtitles.length} -> ${normalizedItems.length} subtitles`, {
    allowUnknown: config.allowUnknownLanguages
  });

  const effectiveWhitelist = (config.languages && config.languages.length > 0)
    ? config.languages
    : ['pob', 'eng'];

  const whitelistedItems = normalizedItems.filter(item =>
    isLanguageWhitelisted(item.lang, effectiveWhitelist)
  );

  Logger.info(`Language whitelist filter: ${normalizedItems.length} -> ${whitelistedItems.length} subtitles`, {
    whitelist: effectiveWhitelist
  });

  let orderedItems = prioritizeSubtitles(whitelistedItems, config.providerPriority);

  if (config.deduplication) {
    const beforeCount = orderedItems.length;
    // Exact file-hash matches must never be merged away as "duplicates" of a similar release
    const hashMatched = orderedItems.filter(i => i.rawMetadata?.moviehashMatch === true);
    const others = orderedItems.filter(i => i.rawMetadata?.moviehashMatch !== true);
    orderedItems = [...hashMatched, ...deduplicateSubtitles(others, 0.85, config.deduplicationStrategy || 'both')];
    Logger.info(`Deduplication: ${beforeCount} -> ${orderedItems.length} subtitles${hashMatched.length ? ` (${hashMatched.length} hash match)` : ''}`);
  }

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
  } catch (err) {
    Logger.error('Scoring failed, keeping provider order', err);
  }

  // Build clean response with original IDs, normalized language codes, absolute URLs, and formatted display title
  const subtitles: StremioSubtitle[] = orderedItems.map(item => {
    let finalUrl = item.url;
    if (finalUrl.startsWith('/')) {
      finalUrl = `${baseUrl}${finalUrl}`;
    } else if (finalUrl.startsWith('http://') || finalUrl.startsWith('https://')) {
      // If external URL ends with .zip or is an archive, route through /sub/proxy to decompress and serve valid text
      if (/\.zip($|\?)/i.test(finalUrl)) {
        const ext = item.format === 'vtt' || finalUrl.toLowerCase().endsWith('.vtt') ? '.vtt' : '.srt';
        const safeBaseName = (item.release || item.id).replace(/[^a-zA-Z0-9._-]/g, '_');
        const safeFilename = safeBaseName.endsWith(ext) ? safeBaseName : `${safeBaseName}${ext}`;
        finalUrl = `${baseUrl}/sub/proxy?url=${encodeURIComponent(finalUrl)}&filename=${encodeURIComponent(safeFilename)}`;
      }
    }

    const displayTitle = item.release || `${item.providerName || item.provider} Subtitle`;

    return {
      id: item.id,
      lang: item.lang,
      url: finalUrl,
      title: displayTitle
    };
  });

  return {
    subtitles
  };
}
