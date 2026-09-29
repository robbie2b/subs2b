import { RawSubtitleItem } from '../types/provider';

/**
 * Bazarr-style subtitle scoring: compares each subtitle's release name with the playing video's
 * file name (release group, source, resolution, streaming service, codec, edition) and rejects
 * subtitles that clearly belong to another title / year / episode.
 */

export type Source = 'remux' | 'bluray' | 'webdl' | 'webrip' | 'hdtv' | 'dvd' | 'hdrip' | 'cam';

export interface ParsedRelease {
  raw: string;
  titleTokens: string[];
  year: number | null;
  season: number | null;
  episode: number | null;
  resolution: number | null;
  source: Source | null;
  service: string | null;
  codec: string | null;
  edition: string[];
  group: string | null;
  badQuality: boolean;
  /** true when the name carries real release info (year, source, resolution or group) */
  informative: boolean;
}

export interface ScoringContext {
  /** File name of the video being played (Stremio `filename` extra), if the player sent it */
  filename?: string | null;
  /** Requested season/episode (series) */
  season?: number | null;
  episode?: number | null;
  /** Extra points per provider id (substring match), e.g. { subsro: 8 } */
  providerBonus?: Record<string, number>;
}

export interface ScoreDetail {
  release: string;
  provider: string;
  score: number;
  rejected: boolean;
  reasons: string[];
}

export interface RankResult {
  items: RawSubtitleItem[];
  details: ScoreDetail[];
  usedFilename: boolean;
  fallback: boolean;
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'and', 'vol', 'volume', 'volumul', 'part', 'movie', 'film']);

const NOT_A_GROUP = new Set([
  'dl', 'hd', 'ma', 'rip', 'ray', 'dts', 'aac', 'ac3', 'ddp', 'dd', 'web', 'bluray', 'sub', 'subs', 'hdr', 'dv',
  'hdr10', 'imax', 'mkv', 'remux', 'x264', 'x265', 'hevc', 'avc', 'atmos', 'truehd', 'flac', 'mp4', 'avi', 'hc',
  'ws', 'sd', 'uhd', '4k', 'ro', 'en', 'srt', 'rar', 'zip', 'variante', 'comm'
]);

const LANG_SUFFIX = /[. ](ro|en|is|dan|fin|nor|swe|hun|ell|deu|fra|ita|spa|por|pob|tur|pol|hin|ara|heb|kor|jpn|chi|zho|ces|slk|slv|srp|hrv|bul|ukr|rus|vie|tha|ind|msa|may|ger|fre|eng|rum|ron)$/i;

const SERVICES: Array<[RegExp, string]> = [
  [/\b(nf|netflix)\b/, 'nf'],
  [/\b(amzn|amazon)\b/, 'amzn'],
  [/\b(dsnp|dsny|disney)\b/, 'dsnp'],
  [/\b(hmax|hbomax|hbo max)\b/, 'hmax'],
  [/\b(atvp|appletv)\b/, 'atvp'],
  [/\bhulu\b/, 'hulu'],
  [/\b(pcok|peacock)\b/, 'pcok'],
  [/\b(pmtp|paramount)\b/, 'pmtp'],
  [/\bvoyo\b/, 'voyo']
];

const EDITIONS: Array<[RegExp, string]> = [
  [/\bextended\b/, 'extended'],
  [/\bunrated\b/, 'unrated'],
  [/\b(directors cut|director s cut)\b/, 'directors'],
  [/\btheatrical\b/, 'theatrical'],
  [/\bimax\b/, 'imax'],
  [/\bremastered\b/, 'remastered'],
  [/\buncut\b/, 'uncut'],
  [/\bfinal cut\b/, 'finalcut'],
  [/\bspecial edition\b/, 'special']
];

function normalize(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectSource(norm: string): Source | null {
  if (/\b(cam|camrip|hdcam|ts|hdts|telesync|tc|hdtc|telecine|scr|screener|dvdscr|predvd|trial)\b/.test(norm)) return 'cam';
  if (/\b(remux|bdremux)\b/.test(norm)) return 'remux';
  if (/\b(blu ray|bluray|bdrip|brrip|bd rip|br rip|bd25|bd50)\b/.test(norm)) return 'bluray';
  if (/\b(web dl|webdl)\b/.test(norm)) return 'webdl';
  if (/\b(web rip|webrip)\b/.test(norm)) return 'webrip';
  if (/\bweb\b/.test(norm)) return 'webdl';
  if (/\b(hdtv|pdtv|dsr)\b/.test(norm)) return 'hdtv';
  if (/\bhdrip\b/.test(norm)) return 'hdrip';
  if (/\b(dvd|dvdrip|dvdr)\b/.test(norm)) return 'dvd';
  return null;
}

function detectResolution(norm: string): number | null {
  if (/\b(2160p|4k|uhd)\b/.test(norm)) return 2160;
  if (/\b(1080p|1080i|fhd)\b/.test(norm)) return 1080;
  if (/\b720p\b/.test(norm)) return 720;
  if (/\b(576p|480p|sd)\b/.test(norm)) return 480;
  return null;
}

function detectGroup(raw: string): string | null {
  let s = raw
    .replace(/\.(srt|vtt|ass|ssa|mkv|mp4|avi)$/i, '')
    .replace(/\s+\d{1,2}[;:.]\d{2}[;:.]\d{2}.*$/, '') // trailing runtime / size junk
    .trim();

  // bracketed tags: "[YTS.MX]", "[DVDRip]" -> use the first one that looks like a release group
  const bracket = s.match(/\[([A-Za-z][A-Za-z0-9]*)(?:\.[A-Za-z0-9]+)?\]\s*$/);
  if (bracket && /^(yts|rarbg|ettv|eztv|psa|tigole|ntb|fgt|galaxyrg)$/i.test(bracket[1])) {
    return bracket[1].toLowerCase();
  }
  s = s.replace(/\s*\[[^\]]*\]\s*$/, '').trim();

  for (let i = 0; i < 2; i++) {
    const next = s.replace(LANG_SUFFIX, '');
    if (next === s) break;
    s = next;
  }

  const m = s.match(/-([A-Za-z0-9]{2,15})$/);
  if (!m) return null;
  const g = m[1].toLowerCase();
  if (NOT_A_GROUP.has(g) || /^\d+$/.test(g) || /^\d{3,4}p$/.test(g)) return null;
  return g;
}

export function parseRelease(raw: string): ParsedRelease {
  const norm = normalize(raw || '');

  const se = norm.match(/\bs(\d{1,2}) ?e(\d{1,3})\b/) || norm.match(/\b(\d{1,2}) ?x ?(\d{2,3})\b/);
  const seasonOnly = !se ? norm.match(/\b(?:s|season|sezon|sezonul) ?(\d{1,2})\b/) : null;
  const season = se ? parseInt(se[1], 10) : seasonOnly ? parseInt(seasonOnly[1], 10) : null;
  const episode = se ? parseInt(se[2], 10) : null;

  const yearMatch = norm.match(/\b(19\d{2}|20\d{2})\b/);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

  const source = detectSource(norm);
  const resolution = detectResolution(norm);

  let service: string | null = null;
  for (const [re, name] of SERVICES) {
    if (re.test(norm)) {
      service = name;
      break;
    }
  }

  let codec: string | null = null;
  if (/\b(x265|h 265|hevc)\b/.test(norm)) codec = 'h265';
  else if (/\b(x264|h 264|avc)\b/.test(norm)) codec = 'h264';
  else if (/\bxvid\b/.test(norm)) codec = 'xvid';
  else if (/\bav1\b/.test(norm)) codec = 'av1';

  const edition = EDITIONS.filter(([re]) => re.test(norm)).map(([, name]) => name);

  const group = detectGroup(raw || '');

  // Title = words before the first year / season-episode / technical token
  const cutPatterns = [
    yearMatch ? new RegExp('\\b' + yearMatch[1] + '\\b') : null,
    se ? /\bs\d{1,2} ?e\d{1,3}\b|\b\d{1,2} ?x ?\d{2,3}\b/ : null,
    /\b(2160p|1080p|1080i|720p|576p|480p|4k|uhd|bluray|blu ray|bdrip|brrip|remux|web dl|webdl|web rip|webrip|hdtv|dvdrip|dvd|hdrip|hdtc|hdts|cam|xvid|x264|x265|hevc|extended|unrated)\b/
  ].filter((r): r is RegExp => r !== null);
  let cut = norm.length;
  for (const re of cutPatterns) {
    const m = re.exec(norm);
    if (m && m.index < cut) cut = m.index;
  }
  const titleTokens = norm
    .slice(0, cut)
    .split(' ')
    .filter(t => t && !STOP_WORDS.has(t));

  return {
    raw,
    titleTokens,
    year,
    season,
    episode,
    resolution,
    source,
    service,
    codec,
    edition,
    group,
    badQuality: source === 'cam',
    informative: year !== null || source !== null || resolution !== null || group !== null
  };
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  sa.forEach(t => {
    if (sb.has(t)) inter++;
  });
  return inter / (sa.size + sb.size - inter);
}

const TITLE_MATCH_THRESHOLD = 0.5;

/** Reference title: the one most similar to all others (used when the player sends no file name). */
function medoidTitle(parsed: ParsedRelease[]): string[] | null {
  const candidates = parsed.filter(p => p.informative && p.titleTokens.length > 0);
  if (candidates.length === 0) return null;
  let best: ParsedRelease | null = null;
  let bestScore = -1;
  for (const c of candidates) {
    let total = 0;
    for (const o of candidates) total += jaccard(c.titleTokens, o.titleTokens);
    if (total > bestScore) {
      bestScore = total;
      best = c;
    }
  }
  return best ? best.titleTokens : null;
}

function mostCommonYear(parsed: ParsedRelease[]): number | null {
  const counts = new Map<number, number>();
  for (const p of parsed) {
    if (p.year !== null) counts.set(p.year, (counts.get(p.year) || 0) + 1);
  }
  let best: number | null = null;
  let bestCount = 0;
  counts.forEach((count, year) => {
    if (count > bestCount) {
      best = year;
      bestCount = count;
    }
  });
  return best;
}

function sourceScore(sub: Source | null, video: Source | null): { points: number; reason: string } {
  if (!sub || !video) return { points: 0, reason: '' };
  if (sub === video) return { points: 25, reason: 'source=' + sub };
  const pair = [sub, video].sort().join('+');
  if (pair === 'bluray+remux') return { points: 20, reason: 'source~bluray/remux' };
  if (pair === 'webdl+webrip') return { points: 12, reason: 'source~web' };
  return { points: -5, reason: 'source!=' + sub };
}

/** Preference when there is no file name to compare against */
function baselineSource(source: Source | null): number {
  switch (source) {
    case 'webdl':
    case 'bluray':
      return 12;
    case 'remux':
      return 10;
    case 'webrip':
      return 8;
    case 'hdtv':
      return 4;
    case 'dvd':
    case 'hdrip':
      return 3;
    default:
      return 0;
  }
}

function baselineResolution(res: number | null): number {
  if (res === 1080) return 6;
  if (res === 720) return 5;
  if (res === 2160) return 4;
  if (res === 480) return 1;
  return 0;
}

interface Reference {
  titleTokens: string[] | null;
  year: number | null;
}

function scoreOne(
  item: RawSubtitleItem,
  sub: ParsedRelease,
  video: ParsedRelease | null,
  ref: Reference,
  ctx: ScoringContext
): ScoreDetail {
  const reasons: string[] = [];
  let score = 0;
  let rejected = false;

  const isSeries = ctx.season != null && ctx.episode != null;

  // ---- strict filters: other title / year / episode ----
  if (sub.informative && ref.titleTokens && sub.titleTokens.length > 0) {
    if (jaccard(sub.titleTokens, ref.titleTokens) < TITLE_MATCH_THRESHOLD) {
      rejected = true;
      reasons.push('title mismatch');
    }
  }
  if (!isSeries && sub.year !== null && ref.year !== null && Math.abs(sub.year - ref.year) > 1) {
    rejected = true;
    reasons.push('year mismatch ' + sub.year + ' vs ' + ref.year);
  } else if (!isSeries && sub.year !== null && ref.year !== null) {
    score += sub.year === ref.year ? 3 : -4;
  }
  if (isSeries) {
    if (sub.season !== null && sub.season !== ctx.season) {
      rejected = true;
      reasons.push('season mismatch S' + sub.season);
    } else if (sub.episode !== null && sub.episode !== ctx.episode) {
      rejected = true;
      reasons.push('episode mismatch E' + sub.episode);
    } else if (sub.season !== null && sub.episode !== null) {
      score += 20;
      reasons.push('episode match');
    }
  }

  // ---- similarity to the video file ----
  if (video) {
    if (sub.group && video.group) {
      if (sub.group === video.group) {
        score += 50;
        reasons.push('group=' + sub.group);
      }
    }
    const src = sourceScore(sub.source, video.source);
    score += src.points;
    if (src.reason) reasons.push(src.reason);

    if (sub.resolution && video.resolution) {
      if (sub.resolution === video.resolution) {
        score += 10;
        reasons.push('res=' + sub.resolution);
      } else {
        score -= 3;
      }
    }
    if (sub.service && video.service) {
      if (sub.service === video.service) {
        score += 10;
        reasons.push('service=' + sub.service);
      } else {
        score -= 3;
      }
    }
    if (sub.codec && video.codec && sub.codec === video.codec) {
      score += 3;
      reasons.push('codec=' + sub.codec);
    }
    const subEd = sub.edition.slice().sort().join(',');
    const vidEd = video.edition.slice().sort().join(',');
    if (subEd === vidEd) {
      if (vidEd) {
        score += 10;
        reasons.push('edition=' + vidEd);
      }
    } else if (subEd) {
      score -= 12;
      reasons.push('edition!=' + subEd);
    } else if (vidEd) {
      score -= 3;
    }
  } else {
    score += baselineSource(sub.source) + baselineResolution(sub.resolution);
    if (sub.group) score += 2;
  }

  if (item.rawMetadata && item.rawMetadata.moviehashMatch === true) {
    score += 200;
    reasons.push('HASH MATCH (exact file)');
  }

  if (sub.badQuality) {
    score -= 100;
    reasons.push('bad quality (cam/ts)');
  }
  if (item.hearingImpaired) score -= 3;

  const downloads = typeof item.downloads === 'number' ? item.downloads : 0;
  if (downloads > 0) score += Math.min(5, Math.log10(downloads + 1));

  if (ctx.providerBonus) {
    const providerId = (item.provider || '').toLowerCase();
    for (const key of Object.keys(ctx.providerBonus)) {
      if (providerId.includes(key.toLowerCase())) {
        score += ctx.providerBonus[key];
        break;
      }
    }
  }

  return {
    release: item.release || '',
    provider: item.provider,
    score: Math.round(score * 10) / 10,
    rejected,
    reasons
  };
}

/**
 * Scores and orders subtitles, best first. Clearly wrong subtitles (other title/year/episode) are dropped
 * unless that would leave nothing; in that case the original list is returned untouched (safety fallback).
 */
export function rankSubtitles(items: RawSubtitleItem[], ctx: ScoringContext): RankResult {
  if (items.length === 0) {
    return { items, details: [], usedFilename: false, fallback: false };
  }

  const parsedItems = items.map(i => parseRelease(i.release || ''));
  const filename = ctx.filename && ctx.filename.trim() ? ctx.filename.trim() : null;
  const video = filename ? parseRelease(filename) : null;

  const medoid = medoidTitle(parsedItems);
  let refTokens: string[] | null = medoid;
  if (video && video.titleTokens.length > 0) {
    // trust the file name's title only when it agrees with what the providers returned
    if (!medoid || jaccard(video.titleTokens, medoid) >= TITLE_MATCH_THRESHOLD) {
      refTokens = video.titleTokens;
    }
  }
  const refYear = video && video.year !== null && refTokens === video.titleTokens ? video.year : mostCommonYear(parsedItems);
  const reference: Reference = { titleTokens: refTokens, year: refYear };

  const details = items.map((item, idx) => scoreOne(item, parsedItems[idx], video, reference, ctx));

  const order = items.map((_, idx) => idx);
  const kept = order.filter(idx => !details[idx].rejected);

  if (kept.length === 0) {
    return { items, details, usedFilename: Boolean(video), fallback: true };
  }

  kept.sort((a, b) => details[b].score - details[a].score || a - b);

  return {
    items: kept.map(idx => items[idx]),
    details: kept.map(idx => details[idx]).concat(order.filter(idx => details[idx].rejected).map(idx => details[idx])),
    usedFilename: Boolean(video),
    fallback: false
  };
}
