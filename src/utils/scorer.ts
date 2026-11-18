import { RawSubtitleItem } from '../types/provider';

/**
 * Bazarr-style subtitle scoring: compares each subtitle's release name with the playing video's
 * file name (release group, source, resolution, streaming service, codec, edition) and rejects
 * subtitles that clearly belong to another title / year / episode.
 */

export type Source = 'remux' | 'bluray' | 'webdl' | 'webrip' | 'hdtv' | 'dvd' | 'hdrip' | 'cam';

export interface ParsedRelease {
  titleTokens: string[];
  seasonTo: number | null;
  episodeTo: number | null;
  looseEpisode: number | null;
  seriesYear: number | null;
  trailingNumber: number | null;
  code: number | null;
  special: boolean;
  date: string | null;
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

/**
 * Optional scoring rules that are compared against the baseline before being switched on
 * (see test/scorerRules.test.ts for the comparison on the known cases).
 */
export interface RuleFlags {
  /** a group name that only differs by a tracker/suffix ("demand" vs "demandrarbg") counts as a partial group match */
  fuzzyGroup: boolean;
  /** neighbouring source tiers (BluRay vs WEB-DL, WEB vs HDTV...) get partial credit instead of a penalty */
  sourceTiers: boolean;
  /** names listing several releases ("a;b;c") are scored per variant, the best one counts */
  multiVariant: boolean;
  /** a name that is exactly the file's release joins the hash matches on top, the provider priority deciding */
  exactTier: boolean;
}

// fuzzyGroup and multiVariant are safe (see the hazard cases in test/scorerRules.test.ts) and on by default.
// sourceTiers only reorders neighbouring sources and nothing shows it helps synchronisation, so it stays off.
export const DEFAULT_RULES: RuleFlags = { fuzzyGroup: true, sourceTiers: false, multiVariant: true, exactTier: true };

/** Changes the defaults (used by the tests to run the whole suite with every optional rule switched on) */
export function setDefaultRules(rules: Partial<RuleFlags>): void {
  Object.assign(DEFAULT_RULES, rules);
}

function ruleOn(ctx: ScoringContext, name: keyof RuleFlags): boolean {
  return ctx.rules?.[name] ?? DEFAULT_RULES[name];
}

export interface ScoringContext {
  /** File name of the video being played (Stremio `filename` extra), if the player sent it */
  filename?: string | null;
  /** Requested season/episode (series) */
  season?: number | null;
  episode?: number | null;
  /** Extra points per provider id (substring match), e.g. { subsro: 8 } */
  providerBonus?: Record<string, number>;
  /** The user's provider order (Filters → Priority): decides between the subtitles of the top tier */
  providerPriority?: string[];
  rules?: Partial<RuleFlags>;
}

export interface ScoreDetail {
  release: string;
  provider: string;
  /** the language of the subtitle (Debug shows it: which language each rank is in) */
  lang?: string;
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

/**
 * Streaming services: the short tags (AMZN, NF, SKST...) are looked for in the whole name (they sit before the resolution
 * as often as after it: "Show.S01E01.AMZN.WEB-DL.1080p"); the full words (Amazon, Netflix, Disney...) only after the title,
 * since they can be part of one ("Tears of the Amazon").
 */
const SERVICES: Array<[RegExp | null, RegExp | null, string]> = [
  [/\bnf\b/, /\bnetflix\b/, 'nf'],
  [/\bamzn\b/, /\bamazon\b/, 'amzn'],
  [/\b(dsnp|dsny)\b/, /\bdisney\b/, 'dsnp'],
  [/\bhmax\b/, /\b(hbomax|hbo max)\b/, 'hmax'],
  [/\b(atvp|atv)\b/, /\bappletv\b/, 'atvp'],
  [/\bhulu\b/, null, 'hulu'],
  [/\bpcok\b/, /\bpeacock\b/, 'pcok'],
  [/\bpmtp\b/, /\bparamount\b/, 'pmtp'],
  [null, /\bvoyo\b/, 'voyo'],
  [/\bskst\b/, null, 'skst']
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
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&amp;|&/g, ' and ')
    // dotted acronyms: U.S. -> us, F.R.I.E.N.D.S. -> friends
    .replace(/(?<![a-z0-9])([a-z])\.(?=[a-z](?:\.|(?![a-z0-9])))/g, '$1')
    // apostrophes join, they do not split: Ocean's -> oceans
    .replace(/['\u2019`\u00b4]/g, '')
    // a resolution glued to a word ("amb-friends720p", "1080pBluRay") is a word of its own
    .replace(/([a-z])(\d{3,4}p)(?![a-z0-9])/g, '$1 $2')
    .replace(/(?<![a-z0-9])(\d{3,4}p)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The part of a name after the title: from the first year or resolution (a title may hold "cam", "trial", "amazon"...) */
function afterTitle(norm: string): string {
  const m = /\b(19\d{2}|20\d{2}|2160p|1080p|1080i|720p|576p|480p|4k|uhd)\b/.exec(norm);
  return m && m.index > 0 ? norm.slice(m.index) : norm;
}

function detectSource(fullNorm: string): Source | null {
  const norm = fullNorm;
  if (/\b(camrip|hdcam|hdts|telesync|hdtc|telecine|screener|dvdscr|predvd)\b/.test(norm)) return 'cam';
  if (/\b(cam|ts|tc|scr|trial)\b/.test(afterTitle(norm))) return 'cam';
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
  s = s.replace(/-rum(\(\d+\))?$/i, '').trim();
  const dotted = s.match(/\.(yify|yts|rarbg|ettv|eztv)$/i);
  if (dotted) return dotted[1].toLowerCase();

  for (let i = 0; i < 2; i++) {
    const next = s.replace(LANG_SUFFIX, '');
    if (next === s) break;
    s = next;
  }

  // Some releases put the group inside the closing parenthesis: "(... English - HONE)"
  s = s.replace(/\)\s*$/, '').trim();

  const m = s.match(/-\s*([A-Za-z0-9]{2,15})$/);
  if (!m) return null;
  const g = m[1].toLowerCase();
  if (NOT_A_GROUP.has(g) || /^\d+$/.test(g) || /\d{3,4}p$/.test(g)) return null;
  return g;
}

/**
 * Release names written in brackets after a title (Subs.ro: "Title - S3E1.ro [Show.S03.1080p.WEB-DL-GRP]"),
 * nested brackets included. Short labels ("[Lektor PL]") are left out.
 */
export function bracketedReleases(text: string): string[] {
  const out: string[] = [];
  const walk = (t: string) => {
    let depth = 0, start = -1;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '[') { if (depth === 0) start = i + 1; depth++; }
      else if (t[i] === ']' && depth > 0) {
        depth--;
        if (depth === 0) {
          const inner = t.slice(start, i);
          const flat = inner.replace(/\[[^\]]*\]/g, ' ').trim();
          if (/[.\- ]/.test(flat) && /[a-z]{2}/i.test(flat) && flat.length >= 8) out.push(flat);
          if (inner.includes('[')) walk(inner);
        }
      }
    }
  };
  walk(text);
  return out.filter((v, i) => out.indexOf(v) === i && v !== text);
}

/** Every release a subtitle name stands for: the parts separated by ";" and the release names in brackets */
export function variantsOf(release: string | undefined | null): string[] {
  const list: string[] = [];
  for (const part of (release || '').split(';').map(v => v.trim()).filter(Boolean)) {
    list.push(part, ...bracketedReleases(part));
  }
  return list.length ? list : [''];
}

/**
 * The same release names are read again and again (ranking, labels, Subsync checks, every request of a film): the
 * result is remembered. Callers never change a ParsedRelease.
 */
const PARSE_CACHE_MAX = 4000;
const parseCache = new Map<string, ParsedRelease>();
export function parseRelease(raw: string): ParsedRelease {
  const key = raw || '';
  const hit = parseCache.get(key);
  if (hit) return hit;
  const parsed = parseReleaseUncached(key);
  if (parseCache.size >= PARSE_CACHE_MAX) parseCache.clear();
  parseCache.set(key, parsed);
  return parsed;
}


/** Episode number written without S01E02 ("Show - 05", "Show_05_", "Episode 5", "[Sub] Show 05 [1080p]"): used for anime / absolute numbering */
function looseEpisodeOf(rawLower: string, norm: string): number | null {
  const ep = norm.match(/(?:^| )(?:ep|episode|episodul|episod) ?0*(\d{1,4})(?= |$)/);
  if (ep) return parseInt(ep[1], 10);
  const base = rawLower.replace(/\.(mkv|mp4|avi|srt|vtt)$/, '');
  const m = base.match(/(?:\s-\s|_|\.-\.|\s)0*(\d{2,4})(?:v\d)?(?=[\s._\[(\-]|$)/g);
  if (!m) return null;
  for (const piece of m) {
    const n = parseInt(piece.replace(/\D/g, '').replace(/v\d$/, ''), 10);
    if (!(n >= 1900 && n <= 2099) && !/^(480|576|720|1080|2160)$/.test(String(n)) && n < 1000) {
      // not followed by p/i (resolution) -- the lookahead above already rejects "720p"
      return n;
    }
  }
  return null;
}

const NUMBER_WORDS: Record<string, string> = { two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', twenty: '20',
  ii: '2', iii: '3', iv: '4', vi: '6', vii: '7', viii: '8', ix: '9', x: '10', xi: '11', xii: '12' };
/** Same number written as a word, a roman numeral or digits ("Ocean's Eleven" = "Ocean's 11", "Rocky II" = "Rocky 2") */
function canonTokens(tokens: string[]): string[] {
  return tokens.map((t, i) => (i > 0 ? NUMBER_WORDS[t] : undefined) ?? t);
}
function sequelNumber(tokens: string[]): number {
  const last = tokens[tokens.length - 1];
  if (tokens.length >= 2 && /^\d{1,2}$/.test(last)) return parseInt(last, 10);
  if (tokens.length >= 2 && (last === 'i' || last === 'one')) return 1;
  return 1;
}

function parseReleaseUncached(raw: string): ParsedRelease {
  const norm = normalize(raw || '');
  // fansub tag in front ("[SubsPlease] Show - 05"): not part of the title
  const normT = /^\s*\[[^\]]*\]\s*[^\[\s]/.test(raw || '') ? normalize((raw || '').replace(/^(\s*\[[^\]]*\])+/, '')) : norm;

  const se = norm.match(/\bs ?(\d{1,2}) ?e ?(\d{1,3})\b/) || norm.match(/\bs(\d{1,2})e(\d{1,3})(?=e\d)/) || norm.match(/\b(\d{1,2}) ?x ?(?!26[456]\b)(\d{2,3})\b/);
  const rawLower = (raw || '').toLowerCase();
  // "Friends - 314 - The One With..." / "F.R.I.E.N.D.S. 315 - ...": season and episode written together (S3E14)
  const sseeM = !se ? rawLower.match(/(?:\s-\s|\s)([1-9]\d?)(\d{2})\s-\s/) : null;
  const ssee = sseeM && !(parseInt(sseeM[1] + sseeM[2], 10) >= 1900 && parseInt(sseeM[1] + sseeM[2], 10) <= 2099) ? sseeM : null;
  const multi = rawLower.match(/s(\d{1,2})e(\d{1,3})(?:e(\d{1,3})|-e?(\d{1,3}))(?![\dp])/) || rawLower.match(/\b(\d{1,2})x(\d{2,3})-(\d{2,3})(?![\dp])/);
  const range = norm.match(/\bs(\d{1,2}) ?(?:s|to)? ?(\d{1,2})\b(?! ?e)/) ;
  const rangeRaw = rawLower.match(/\bs(\d{1,2})[ ._]?-[ ._]?s?(\d{1,2})\b(?!e)/) || rawLower.match(/\bseasons?[ ._]?(\d{1,2})[ ._]?-[ ._]?(\d{1,2})\b/) || rawLower.match(/\bsezoan?el?e?[ ._]?(\d{1,2})[ ._]?-[ ._]?(\d{1,2})\b/);
  const seasonOnly = !se ? norm.match(/\b(?:s|season|sezon|sezonul) ?(\d{1,2})\b/) : null;
  const season = se ? parseInt(se[1], 10) : rangeRaw ? parseInt(rangeRaw[1], 10) : seasonOnly ? parseInt(seasonOnly[1], 10) : null;
  const seasonTo = !se && rangeRaw ? parseInt(rangeRaw[2], 10) : null;
  const episode = se ? parseInt(se[2], 10) : null;
  const code = ssee ? parseInt(ssee[1] + ssee[2], 10) : null;
  const episodeTo = multi ? parseInt(multi[3] || multi[4], 10) : null;

  const dateM = norm.match(/\b(19\d{2}|20\d{2}) (0[1-9]|1[0-2]) (0[1-9]|[12]\d|3[01])\b/);
  const yearMatch = norm.match(/\b(19\d{2}|20\d{2})\b/);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

  const source = detectSource(norm);
  const resolution = detectResolution(norm);

  let service: string | null = null;
  const afterName = afterTitle(norm);
  for (const [code, word, name] of SERVICES) {
    if ((code && code.test(norm)) || (word && word.test(afterName))) {
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
  const special = /\b(ova|oad|oav|specials?|recap|making of|behind the scenes|featurette|nced|ncop)\b/.test(norm);
  const looseEpisode = se || ssee ? null : looseEpisodeOf(rawLower, norm);

  // Title = words before the first year / season-episode / technical token
  const cutPatterns = [
    yearMatch ? new RegExp('\\b' + yearMatch[1] + '\\b') : null,
    ssee ? new RegExp('\\b' + ssee[1] + ssee[2] + '\\b') : null,
    /\b3d\b/,
    se ? /\bs ?\d{1,2} ?e ?\d{1,3}\b|\b\d{1,2} ?x ?\d{2,3}\b/ : null,
    /\bs\d{1,2}\b|\b(?:season|seasons|sezonul|sezon|sezoanele|complete) ?\d{0,2}\b|\b(?:tv series)\b/,
    dateM ? new RegExp('\\b' + dateM[1] + ' ' + dateM[2] + ' ' + dateM[3] + '\\b') : null,
    /\b(2160p|1080p|1080i|720p|576p|480p|4k|uhd|bluray|blu ray|bdrip|brrip|remux|web dl|webdl|web rip|webrip|hdtv|dvdrip|dvd|hdrip|hdtc|hdts|cam|xvid|x264|x265|hevc|extended|unrated|internal|proper|repack|readnfo|dvdscr|dvdr|ntsc|hybrid|multi|pdtv|dsr|tvrip|telesync|cd ?\d)\b/
  ].filter((r): r is RegExp => r !== null);
  let cut = normT.length;
  for (const re of cutPatterns) {
    const m = re.exec(normT);
    if (m && m.index < cut) cut = m.index;
  }
  // strong loose-episode markers: "Show 001 v4", "Show 05 1080p" are decided by looseEpisode; cut the title there
  if (looseEpisode !== null && !se) {
    const strong = (rawLower.match(/(?:\s-\s|_|\s)0*\d{2,4}v\d|(?:\s-\s|_)0*\d{1,4}(?=[\s_\-\[(]|$)|\b0*\d{2,4} v\d\b/) !== null) || /\b(?:ep|episode|episodul|episod) ?\d/.test(norm);
    if (strong) {
      const re = new RegExp('(?:^| )(?:(?:ep|episode|episodul|episod) )?0*' + looseEpisode + '(?: v\\d)?(?= |$)');
      const m = re.exec(normT);
      if (m && m.index > 0 && m.index < cut) cut = m.index;
    }
  }
  const titleTokens = normT
    .slice(0, cut)
    .split(' ')
    .filter(t => t && !STOP_WORDS.has(t));

  return {
    titleTokens: canonTokens(titleTokens),
    seasonTo,
    episodeTo,
    looseEpisode,
    seriesYear: year !== null && (!se || (norm.search(new RegExp('\\b' + year + '\\b')) < norm.search(/\bs ?\d{1,2} ?e ?\d{1,3}\b|\b\d{1,2} ?x ?\d{2,3}\b/))) ? year : null,
    trailingNumber: (() => { const t = canonTokens(titleTokens); const l = t[t.length - 1]; return t.length >= 2 && /^\d{1,3}$/.test(l) ? parseInt(l, 10) : null; })(),
    code,
    special,
    date: dateM ? `${dateM[1]}-${dateM[2]}-${dateM[3]}` : null,
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

/** Language words some sites put before the title ("21_Romanian---Andor..."); only these (with numbers before them) are skipped */
const LEADING_LANG = new Set(['romanian', 'romana', 'ro', 'rum', 'ron', 'english', 'eng', 'en']);
const MAX_TITLE_PREFIX_WORDS = 3;

function stripLeadingLanguage(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && /^\d+$/.test(tokens[i])) i++;
  if (i >= tokens.length || !LEADING_LANG.has(tokens[i])) return tokens;
  while (i < tokens.length && LEADING_LANG.has(tokens[i])) i++;
  return i < tokens.length ? tokens.slice(i) : tokens;
}

/**
 * Same title: enough shared words, or the shorter title is the END of the longer one with at most 3 extra words
 * in front ("Andor" / "Star Wars Andor"). A continuation ("Matrix Reloaded" vs "Matrix") still does not match.
 */
export function titlesMatch(a: string[], b: string[]): boolean {
  const ca = canonTokens(a.filter(t => t !== 'i' || a.length === 1)), cb = canonTokens(b.filter(t => t !== 'i' || b.length === 1));
  if (ca.join('') === cb.join('')) return true; // "john wick" + "chapter 4" = "johnwick chapter4"
  if (sequelNumber(ca) !== sequelNumber(cb)) return false;
  const strip = (t: string[]) => t.filter((x, i) => !(i === t.length - 1 && t.length >= 2 && (x === '1')));
  if (jaccard(strip(ca), strip(cb)) > TITLE_MATCH_THRESHOLD) return true;
  const x = stripLeadingLanguage(strip(ca));
  const y = stripLeadingLanguage(strip(cb));
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length === 0 || long.length - short.length > MAX_TITLE_PREFIX_WORDS) return false;
  const offset = long.length - short.length;
  return short.every((t, i) => long[offset + i] === t);
}

/** Reference title: the one most similar to all others (used when the player sends no file name). */
function medoidTitle(parsed: ParsedRelease[]): string[] | null {
  const candidates = parsed.filter(p => p.informative && p.titleTokens.length > 0);
  if (candidates.length === 0) return null;
  // Most titles are the same word list (one film): they are compared once, with how many times each occurs. The
  // totals and the first-best tie-break are the same as comparing every pair.
  const groups = new Map<string, { tokens: string[]; set: Set<string>; count: number }>();
  for (const c of candidates) {
    const key = c.titleTokens.join(' ');
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { tokens: c.titleTokens, set: new Set(c.titleTokens), count: 1 });
  }
  const list = [...groups.values()];
  let best: string[] | null = null;
  let bestScore = -1;
  for (const c of list) {
    let total = 0;
    for (const o of list) {
      let inter = 0;
      c.set.forEach(t => { if (o.set.has(t)) inter++; });
      total += (inter / (c.set.size + o.set.size - inter)) * o.count;
    }
    if (total > bestScore) {
      bestScore = total;
      best = c.tokens;
    }
  }
  return best;
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

/** Forced / foreign-parts-only subtitles contain only the lines spoken in another language */
export function looksForced(name: string): boolean {
  return /\b(forced|foreign parts?|foreign only|fpo)\b/.test(normalize(name || ''));
}

/** Machine translated / AI generated subtitles */
export function looksMachineTranslated(name: string): boolean {
  return /\b(ai|machine|auto|automatic|google|gpt|chatgpt) (translated|translation|translate)\b/.test(normalize(name || ''));
}

const SOURCE_TIER: Record<Source, number> = { remux: 5, bluray: 4, webdl: 3, webrip: 3, hdtv: 2, hdrip: 2, dvd: 1, cam: 0 };

function sourceScore(sub: Source | null, video: Source | null, tiers = false): { points: number; reason: string } {
  if (!sub || !video) return { points: 0, reason: '' };
  if (sub === video) return { points: 25, reason: 'source=' + sub };
  const pair = [sub, video].sort().join('+');
  if (pair === 'bluray+remux') return { points: 20, reason: 'source~bluray/remux' };
  if (pair === 'webdl+webrip') return { points: 12, reason: 'source~web' };
  if (tiers && sub !== 'cam' && video !== 'cam' && Math.abs(SOURCE_TIER[sub] - SOURCE_TIER[video]) === 1) {
    return { points: 6, reason: 'source~' + sub + '/' + video + ' (neighbour tier)' };
  }
  return { points: -5, reason: 'source!=' + sub };
}

/** Same group apart from a short tracker/suffix: "demand" vs "demandrarbg". Different groups of similar spelling (NTb / NTG) do NOT match. */
export function groupsAlike(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long !== short && long.startsWith(short) && long.length - short.length <= 8;
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
  alt?: string[] | null;
  fileYear?: number | null;
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
  if (ref.titleTokens && sub.titleTokens.length > 0) {
    // a bare name ("Ocean's Thirteen") cannot be judged on its own, but one that shares words with the title and still
    // differs is another film (sequel, spin-off): rejected like an informative one
    const shares = sub.titleTokens.some(t => ref.titleTokens!.includes(t) && t.length > 2);
    // (the title most providers agree on stands for the file's own only when it is the same film number: if most of the
    // list is "Toy Story 2" and the file is "Toy Story 3", the majority is not the film)
    const altUsable = ref.alt && sequelNumber(canonTokens(ref.alt)) === sequelNumber(canonTokens(ref.titleTokens!)) ? ref.alt : null;
    const okTitle = (t: string[]) => titlesMatch(t, ref.titleTokens!) || (altUsable ? titlesMatch(t, altUsable) : false);
    // series: "Naruto 1 - Intra!", "Naruto 001": a trailing number is the episode (absolute numbering), not part of the title
    const withoutNumber = isSeries && sub.episode === null && sub.trailingNumber !== null ? sub.titleTokens.slice(0, -1) : null;
    // (a bare name that shares words with the title but differs is judged only for films: in a series it is often the title of the episode)
    if ((sub.informative || (!isSeries && shares && sub.titleTokens.length >= 2)) && !okTitle(sub.titleTokens) && !(withoutNumber && withoutNumber.length > 0 && okTitle(withoutNumber))) {
      rejected = true;
      reasons.push('title mismatch');
    }
  }
  if (!isSeries && sub.year !== null && ref.year !== null && Math.abs(sub.year - ref.year) > 1) {
    rejected = true;
    reasons.push('year mismatch ' + sub.year + ' vs ' + ref.year);
  } else if (isSeries && sub.seriesYear !== null && ref.fileYear != null && Math.abs(sub.seriesYear - ref.fileYear) > 1 && sub.date === null) {
    rejected = true;
    reasons.push('year mismatch ' + sub.seriesYear + ' vs ' + ref.fileYear);
  } else if (!isSeries && sub.year !== null && ref.year !== null) {
    score += sub.year === ref.year ? 3 : -4;
  }
  if (isSeries) {
    const inSeasons = (n: number | null): boolean => n === null || (sub.season !== null && n >= sub.season && n <= (sub.seasonTo ?? sub.season));
    const inEpisodes = (n: number): boolean => sub.episode !== null && n >= sub.episode && n <= (sub.episodeTo ?? sub.episode);
    if (sub.season !== null && !inSeasons(ctx.season ?? null)) {
      rejected = true;
      reasons.push('season mismatch S' + sub.season);
    } else if (sub.episode !== null && !inEpisodes(ctx.episode as number)) {
      rejected = true;
      reasons.push('episode mismatch E' + sub.episode);
    } else if (sub.season !== null && sub.episode !== null) {
      score += 20;
      reasons.push('episode match');
    } else if (sub.episode === null && sub.code !== null && ctx.season != null && ctx.episode != null) {
      if (sub.code === ctx.season * 100 + ctx.episode) { score += 20; reasons.push('episode match (SEE code)'); }
      else { rejected = true; reasons.push('episode mismatch (code ' + sub.code + ')'); }
    } else if (sub.episode === null && sub.looseEpisode !== null && ctx.episode != null) {
      const expected = video && video.looseEpisode !== null && video.episode === null ? video.looseEpisode : ctx.season === 1 ? ctx.episode : null;
      if (expected !== null && sub.looseEpisode !== expected && sub.looseEpisode !== ctx.episode) {
        rejected = true;
        reasons.push('episode mismatch (number ' + sub.looseEpisode + ')');
      }
    }
    if (sub.special && !(video && video.special)) {
      rejected = true;
      reasons.push('special / OVA / making-of');
    }
    if (sub.date && video && video.date && sub.date !== video.date) {
      rejected = true;
      reasons.push('date mismatch ' + sub.date);
    }
  }

  // ---- similarity to the video file ----
  if (video) {
    // UHD (2160p) and HD releases usually come from different masters of the same film, whose timing differs
    // (measured: 2 s for Game of Thrones S01E01, 25 s for The Godfather). A shared release group name therefore
    // says little when one side is UHD and the other HD, and the resolution class matters more.
    const differentMaster = Boolean(
      sub.resolution && video.resolution && (sub.resolution >= 2160) !== (video.resolution >= 2160)
    );

    if (sub.group && video.group) {
      if (sub.group === video.group) {
        score += differentMaster ? 15 : 50;
        reasons.push('group=' + sub.group + (differentMaster ? ' (other resolution class)' : ''));
      } else if (ruleOn(ctx, 'fuzzyGroup') && groupsAlike(sub.group, video.group)) {
        score += differentMaster ? 6 : 25;
        reasons.push('group~' + sub.group + '/' + video.group);
      }
    }
    const src = sourceScore(sub.source, video.source, ruleOn(ctx, 'sourceTiers'));
    score += src.points;
    if (src.reason) reasons.push(src.reason);

    if (sub.resolution && video.resolution) {
      if (sub.resolution === video.resolution) {
        score += 10;
        reasons.push('res=' + sub.resolution);
      } else if (differentMaster) {
        score -= 12;
        reasons.push('UHD/HD master differs');
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

  if (item.hashMatch === true) {
    score += 200;
    reasons.push('HASH MATCH (exact file)');
  }

  if (sub.badQuality) {
    score -= 100;
    reasons.push('bad quality (cam/ts)');
  }
  if (item.hearingImpaired) score -= 3;
  // A forced subtitle only carries the foreign-language lines: it must never win against a full one
  if (item.forced === true || looksForced(item.release || '')) {
    score -= 60;
    reasons.push('forced (foreign parts only)');
  }
  if (item.aiTranslated === true || looksMachineTranslated(item.release || '')) {
    score -= 8;
    reasons.push('machine translated');
  }

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
    lang: item.lang,
    score: Math.round(score * 10) / 10,
    rejected,
    reasons
  };
}

const isDisc = (s: Source | null): boolean => s === 'remux' || s === 'bluray';

/**
 * The name says the subtitle was made for exactly this file: same group, source, service, edition and episode.
 * The resolution does not matter for WEB and TV releases (the same stream, scaled), but a disc must be of the same
 * class (UHD and HD discs are different masters). `episodeFrom` gives the episode when a bracketed release has none.
 */
function exactFit(sub: ParsedRelease, video: ParsedRelease, ctx: ScoringContext, episodeFrom?: ParsedRelease): boolean {
  if (!video.group || !video.source || sub.group !== video.group || sub.source !== video.source) return false;
  if ((sub.service || null) !== (video.service || null)) return false;
  if (sub.edition.slice().sort().join(',') !== video.edition.slice().sort().join(',')) return false;
  if (isDisc(video.source) && (!sub.resolution || !video.resolution || (sub.resolution >= 2160) !== (video.resolution >= 2160))) return false;
  if (ctx.season != null && ctx.episode != null) {
    const ep = sub.episode !== null ? sub : episodeFrom;
    if (!ep || ep.season !== ctx.season || ep.episode !== ctx.episode) return false;
  }
  return true;
}

/** Some release named by the subtitle (a ";"-separated part or a bracketed release) is exactly the playing file */
export function exactNameMatch(release: string | undefined, filename: string | null | undefined, ctx: ScoringContext = {}): boolean {
  if (!filename || !filename.trim()) return false;
  const video = parseRelease(filename.trim());
  if (!ruleOn(ctx, 'multiVariant')) return exactFit(parseRelease(release || ''), video, ctx);
  for (const part of (release || '').split(';').map(v => v.trim()).filter(Boolean)) {
    const whole = parseRelease(part);
    if (exactFit(whole, video, ctx)) return true;
    if (bracketedReleases(part).some(inner => exactFit(parseRelease(inner), video, ctx, whole))) return true;
  }
  return false;
}

/**
 * Scores and orders subtitles, best first. The top tier holds the subtitles made for exactly this file: an exact
 * hash match, or a name that is exactly the file's release (see exactFit). Between them the user's provider priority
 * decides, then the score. Clearly wrong subtitles (other title/year/episode) are dropped
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
  // a subtitle may carry the title of the FILE or the title most providers agree on (one of them is spelled differently:
  // "Ocean's" / "Oceans", a translated name...): it is rejected only when it matches neither
  const refTokens: string[] | null = video && video.titleTokens.length > 0 ? video.titleTokens : medoid;
  const alt = refTokens !== medoid ? medoid : null;
  const refYear = video && video.year !== null && refTokens === video.titleTokens ? video.year : mostCommonYear(parsedItems);
  const reference: Reference = { titleTokens: refTokens, alt, year: refYear, fileYear: video ? video.seriesYear : null };

  const details = items.map((item, idx) => {
    if (!ruleOn(ctx, 'multiVariant')) return scoreOne(item, parsedItems[idx], video, reference, ctx);
    // several releases listed in one name ("A; B", or "Title.ro [Release-GRP]"): the subtitle fits all of them, so
    // the best variant counts. A release in brackets only adds to a name that is not rejected itself (it often has
    // no episode, so it must never let another episode through).
    const parts = (item.release || '').split(';').map(v => v.trim()).filter(p => p && !/\n|translated by|uploaded by|subtitle (sourced|automatically)/i.test(p));
    const scored: ScoreDetail[] = [];
    const consider = (d: ScoreDetail) => { scored.push(d); };
    for (const part of parts.length > 1 ? parts : [item.release || '']) {
      const whole = parts.length > 1 ? scoreOne({ ...item, release: part }, parseRelease(part), video, reference, ctx)
        : scoreOne(item, parsedItems[idx], video, reference, ctx);
      consider(whole);
      const onlyTitle = whole.rejected && whole.reasons.every(r => !/mismatch/.test(r) || r === 'title mismatch');
      if (whole.rejected && !onlyTitle) continue;
      const wp = parseRelease(part);
      for (const inner of bracketedReleases(part)) {
        const ip = parseRelease(inner);
        const merged = { ...ip, season: ip.season ?? wp.season, episode: ip.episode ?? wp.episode, episodeTo: ip.episodeTo ?? wp.episodeTo };
        const d = scoreOne({ ...item, release: inner }, merged, video, reference, ctx);
        // (when the name as a whole did not fit the title, a variant that has no title of its own, like "[WEB-DL 3 variante]",
        // must not bring it back)
        if (!d.rejected && !(whole.rejected && ip.titleTokens.length === 0)) consider(d);
      }
    }
    const usable = scored.filter(d => !d.rejected);
    const b = (usable.length ? usable : scored).reduce((x, y) => (y.score > x.score ? y : x));
    if (scored.length < 2) return b;
    return { ...b, release: item.release || '', reasons: ['best of ' + scored.length + ' variants', ...b.reasons] };
  });

  const order = items.map((_, idx) => idx);
  const kept = order.filter(idx => !details[idx].rejected);

  if (kept.length === 0) {
    return { items, details, usedFilename: Boolean(video), fallback: true };
  }

  // (a forced or machine translated subtitle is never put there by its name)
  const top = new Set(kept.filter(idx => items[idx].hashMatch === true || (video && ruleOn(ctx, 'exactTier') && exactNameMatch(items[idx].release, filename, ctx) &&
    items[idx].forced !== true && !looksForced(items[idx].release || '') &&
    items[idx].aiTranslated !== true && !looksMachineTranslated(items[idx].release || ''))));
  for (const idx of top) {
    if (items[idx].hashMatch !== true) details[idx] = { ...details[idx], reasons: [...details[idx].reasons, 'EXACT NAME MATCH (same release as the file)'] };
  }
  const priority = new Map((ctx.providerPriority || []).map((id, i) => [id.toLowerCase(), i] as [string, number]));
  const rankOf = (idx: number): number => priority.get((items[idx].provider || '').toLowerCase()) ?? 999;
  kept.sort((a, b) => {
    const ta = top.has(a), tb = top.has(b);
    if (ta !== tb) return ta ? -1 : 1;
    if (ta && rankOf(a) !== rankOf(b)) return rankOf(a) - rankOf(b);
    return details[b].score - details[a].score || a - b;
  });

  return {
    items: kept.map(idx => items[idx]),
    details: kept.map(idx => details[idx]).concat(order.filter(idx => details[idx].rejected).map(idx => details[idx])),
    usedFilename: Boolean(video),
    fallback: false
  };
}
