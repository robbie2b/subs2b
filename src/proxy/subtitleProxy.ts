import { Request, Response } from 'express';
import axios from 'axios';
import AdmZip from 'adm-zip';
import iconv from 'iconv-lite';
import zlib from 'zlib';
import path from 'path';
import { LRUCache } from 'lru-cache';
import { Logger } from '../utils/logger';
import { isWebVtt, vttToSrt, isMicroDvd, microDvdToSrt } from '../utils/subtitleFormat';
import { decodeTicket, regieLiveApiKey, regieLiveHeaders, REGIELIVE_DOWNLOAD_HOST } from '../providers/regielive';
import { parseRelease, rankSubtitles } from '../utils/scorer';
import { configStorage } from '../storage/configStore';
import { UserConfig } from '../types/config';
import { USER_AGENT, APP_VERSION } from '../config/version';
import { isBlocked, noteRefusal, recoveryFromMessage, statusOf } from '../utils/sourceHealth';
import { BROWSER_UA } from '../utils/html';

/** A subtitle is a small text file: anything bigger inside an archive is ignored (protects the server's memory) */
const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024;

const BROWSER_USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) subs2b/${APP_VERSION}`;

/** Sites the generic proxy is allowed to download from (prevents it from being used as an open proxy) */
const ALLOWED_DOWNLOAD_HOSTS = [
  'subdl.com', 'subsource.net', 'opensubtitles.org', 'opensubtitles.com', 'strem.io',
  'titrari.ro', 'subtitrari-noi.ro', 'yts-subs.com', 'addic7ed.com', 'wyzie.io', 'wyzie.ru'
];

/** Sites that only serve a download asked "from their own pages" (a Referer of the same site) */
const REFERER_REQUIRED: Record<string, string> = {
  'titrari.ro': 'https://www.titrari.ro/',
  'addic7ed.com': 'https://www.addic7ed.com/'
};

/** Sites without an API, read as web pages */
const WEB_PAGE_SITES = ['titrari.ro', 'subtitrari-noi.ro', 'yts-subs.com', 'addic7ed.com'];

/** Romanian sites: an old file without a byte order mark is in the Central European code page (ș, ț, ă) */
const ROMANIAN_HOSTS = ['titrari.ro', 'subtitrari-noi.ro'];

const siteOf = (host: string, list: string[]): string | undefined =>
  list.find(h => host === h || host.endsWith('.' + h));

function isAllowedHost(hostname: string, extraHosts: string[] = []): boolean {
  const host = hostname.toLowerCase();
  return ALLOWED_DOWNLOAD_HOSTS.some(allowed => host === allowed || host.endsWith('.' + allowed)) || extraHosts.includes(host);
}

export function isAllowedDownloadUrl(rawUrl: string, extraHosts: string[] = []): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    return isAllowedHost(url.hostname, extraHosts);
  } catch {
    return false;
  }
}

/** Hosts of the Stremio addons imported by this configuration (their subtitle links may be downloaded and converted) */
export function addonHostsOf(config: UserConfig): string[] {
  const hosts: string[] = [];
  for (const addon of config.customAddons || []) {
    try {
      hosts.push(new URL(addon.manifestUrl.replace(/^stremio:\/\//, 'https://')).hostname.toLowerCase());
    } catch {
      // invalid manifest URL: ignored
    }
  }
  return hosts;
}

function sendError(res: Response, status: number, message: string): void {
  res.status(status);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(message);
}

/**
 * Recursively inspects and decompresses GZIP or ZIP archives.
 * Extracts the primary .srt or .vtt subtitle file.
 */
/** What is being played, so the right file can be chosen inside an archive with several subtitles (season packs) */
export interface ArchivePick {
  season?: number | null;
  episode?: number | null;
  videoFilename?: string | null;
}

/** Episode number written in a file name without a full S01E02 marker: "Show - 04", "Show E04", "Show_04" */
function looseEpisodeOf(name: string): number | null {
  const base = path.basename(name).replace(/\.[a-z0-9]{2,4}$/i, '');
  const withE = base.match(/(?:^|[\s._\-\[(])(?:e|ep|episode|episodul)\s?0*(\d{1,3})(?:[\s._\-\])]|$)/i);
  if (withE) return parseInt(withE[1], 10);
  const trailing = base.match(/[\s._\-]0*(\d{1,3})$/);
  return trailing ? parseInt(trailing[1], 10) : null;
}

const RO_TOKENS = new Set(['ro', 'rom', 'ron', 'romana', 'romanian']);
const FOREIGN_TOKENS = new Set([
  'en', 'eng', 'uk', 'gb', 'us', 'fr', 'fra', 'fre', 'de', 'ger', 'deu', 'es', 'spa', 'it', 'ita', 'nl', 'dut', 'pt', 'por',
  'ru', 'rus', 'hu', 'hun', 'bg', 'bul', 'gr', 'gre', 'ell', 'tr', 'tur', 'pl', 'pol', 'cz', 'cze', 'ar', 'ara', 'zh', 'chi',
  'ja', 'jpn', 'ko', 'kor'
]);

/** Language tag written in a file name ("...ro.srt", "...uk-hi.srt"), compared token by token */
function archiveEntryLanguage(name: string): 'ro' | 'foreign' | null {
  const tokens = path.basename(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.some(t => RO_TOKENS.has(t))) return 'ro';
  if (tokens.some(t => FOREIGN_TOKENS.has(t))) return 'foreign';
  return null;
}

/**
 * Chooses the subtitle inside an archive. Without information about the playing file it is the first .srt (as before).
 * With it: the entries for the requested episode first (season packs), then the one whose release name is most
 * similar to the playing file.
 */
export function pickArchiveEntry<T extends { entryName: string }>(entries: T[], pick?: ArchivePick): T | undefined {
  const srt = entries.filter(e => /\.srt$/i.test(e.entryName));
  const vtt = entries.filter(e => /\.vtt$/i.test(e.entryName));
  const other = entries.filter(e => /\.(sub|ass|ssa)$/i.test(e.entryName));
  const pool = srt.length > 0 ? srt : vtt.length > 0 ? vtt : other.length > 0 ? other : entries;
  if (pool.length <= 1) return pool[0];

  // Archives sometimes hold several languages ("...ro...", "...uk..."): keep the Romanian ones when they exist
  const romanian = pool.filter(e => archiveEntryLanguage(e.entryName) === 'ro');
  // (only when one is tagged as Romanian: short tags such as "it" or "us" can also be part of a title)
  const usable = romanian.length > 0 ? romanian : pool;
  if (!pick) return usable[0];

  let candidates = usable;
  if (pick.episode != null) {
    const wanted = pick.episode;
    const byEpisode = pool.filter(e => {
      const parsed = parseRelease(path.basename(e.entryName));
      if (parsed.episode !== null) return parsed.episode === wanted && (pick.season == null || parsed.season === null || parsed.season === pick.season);
      return looseEpisodeOf(e.entryName) === wanted;
    });
    if (byEpisode.length > 0) candidates = byEpisode;
  }
  if (candidates.length === 1) return candidates[0];

  const filename = (pick.videoFilename || '').trim();
  if (!filename) return candidates[0];

  // Several candidates (releases of the same episode, or an archive we cannot tell apart): the closest name wins
  const items = candidates.map((e, i) => ({
    id: String(i), provider: 'archive', providerName: 'archive', url: '', lang: 'x', release: path.basename(e.entryName).replace(/\.[a-z0-9]{2,4}$/i, '')
  }));
  const ranked = rankSubtitles(items, { filename, season: pick.season, episode: pick.episode });
  return candidates[parseInt(ranked.items[0]?.id ?? '0', 10)] ?? candidates[0];
}

export function decompressBuffer(
  input: Buffer,
  pick?: ArchivePick
): { buffer: Buffer; formatHint?: 'srt' | 'vtt'; filename?: string } {
  let buf = input;
  let formatHint: 'srt' | 'vtt' | undefined;
  let filename: string | undefined;

  for (let pass = 0; pass < 3; pass++) {
    if (!buf || buf.length < 4) break;

    // 1. Detect GZIP (0x1F, 0x8B)
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      try {
        buf = zlib.gunzipSync(buf);
        continue;
      } catch (err) {
        Logger.warn('Failed to gunzip buffer, continuing with raw buffer', { error: String(err) });
        break;
      }
    }

    // 2. Detect ZIP (0x50, 0x4B)
    if (buf[0] === 0x50 && buf[1] === 0x4b) {
      try {
        const zip = new AdmZip(buf);
        const validEntries = zip.getEntries().filter(e =>
          !e.isDirectory &&
          e.header.size <= MAX_SUBTITLE_BYTES &&
          !e.entryName.includes('__MACOSX') &&
          !path.basename(e.entryName).startsWith('.')
        );

        const subEntry = pickArchiveEntry(validEntries, pick);

        if (subEntry) {
          const entryName = subEntry.entryName.toLowerCase();
          if (entryName.endsWith('.vtt')) formatHint = 'vtt';
          else if (entryName.endsWith('.srt')) formatHint = 'srt';
          filename = path.basename(subEntry.entryName);
          buf = subEntry.getData();
          continue;
        }
      } catch (err) {
        Logger.warn('Failed to unzip buffer with AdmZip, continuing with raw buffer', { error: String(err) });
        break;
      }
    }

    break;
  }

  return { buffer: buf, formatHint, filename };
}

/**
 * Accurately decodes buffers of unknown charset (UTF-8, Windows-1252, ISO-8859-1, UTF-16 LE/BE)
 * into a clean UTF-8 string and strips BOMs.
 */
export function toCleanUtf8(buffer: Buffer, legacyCharset: 'win1252' | 'win1250' = 'win1252'): string {
  if (!buffer || buffer.length === 0) return '';

  let text = '';

  // 1. Detect UTF-16 LE BOM or pattern (common in Windows subtitles)
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    text = iconv.decode(buffer, 'utf16le');
  } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    text = iconv.decode(buffer, 'utf16be');
  } else if (buffer.length >= 8 && buffer[1] === 0x00 && buffer[3] === 0x00 && buffer[5] === 0x00) {
    // UTF-16 LE without BOM
    text = iconv.decode(buffer, 'utf16le');
  } else if (buffer.length >= 8 && buffer[0] === 0x00 && buffer[2] === 0x00 && buffer[4] === 0x00) {
    // UTF-16 BE without BOM
    text = iconv.decode(buffer, 'utf16be');
  } else {
    // Standard UTF-8 attempt, falling back to Windows-1252 for Latin diacritics
    const utf8 = buffer.toString('utf8');
    text = utf8.includes('�') ? iconv.decode(buffer, legacyCharset) : utf8;
  }

  // 2. Strip UTF-8 BOM if present at index 0
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  // 3. Normalize CRLF / CR to standard LF
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

/**
 * Validates subtitle timing structure and guarantees correct format rules:
 * - .vtt must strictly start with "WEBVTT" and use '.' timestamp decimals
 * - .srt must begin with numeric index 1 and use ',' timestamp decimals
 */
export function validateAndFormatSubtitle(
  rawText: string,
  preferredFormat: 'srt' | 'vtt' = 'srt'
): { content: string; format: 'srt' | 'vtt'; valid: boolean; reason?: string } {
  let text = rawText.trim();

  if (!text) {
    return { content: '', format: preferredFormat, valid: false, reason: 'Empty subtitle file (0 bytes).' };
  }

  // Detect API error responses returned as body
  if (text.startsWith('{') && (text.includes('"message"') || text.includes('"error"') || text.includes('"status"'))) {
    return { content: text, format: preferredFormat, valid: false, reason: 'JSON error response from the remote API.' };
  }
  if (text.startsWith('<!DOCTYPE') || text.toLowerCase().startsWith('<html')) {
    return { content: text, format: preferredFormat, valid: false, reason: 'HTML error page returned by the remote server.' };
  }

  // Check for presence of cue timing blocks (e.g. 00:00:01,000 --> 00:00:04,000 or 00:00:01.000 --> 00:00:04.000)
  const timingRegex = /((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{2,3})\s*-->\s*((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{2,3})/;
  const match = timingRegex.exec(text);
  if (!match) {
    return { content: text, format: preferredFormat, valid: false, reason: 'No valid timing block (-->) found in the subtitle text.' };
  }

  if (preferredFormat === 'vtt') {
    // If not starting with WEBVTT, convert SRT timestamps and add header
    if (!text.startsWith('WEBVTT')) {
      // Strip any leading non-subtitle headers before first cue if any
      const firstCueIndex = text.indexOf(match[0]);
      if (firstCueIndex > 0) {
        const preCue = text.substring(0, firstCueIndex).trim();
        const preLines = preCue.split('\n');
        const lastPreLine = preLines[preLines.length - 1].trim();
        if (/^\d+$/.test(lastPreLine)) {
          text = `${lastPreLine}\n${text.substring(firstCueIndex)}`;
        } else {
          text = text.substring(firstCueIndex);
        }
      }
      // Replace commas with dots in timestamps
      text = text.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2').replace(/(\d{2}:\d{2}),(\d{3})/g, '$1.$2');
      text = `WEBVTT\n\n${text}`;
    }
    return { content: text, format: 'vtt', valid: true };
  }

  // Preferred format is 'srt'
  if (isWebVtt(text)) {
    text = vttToSrt(text).trim();
  }

  // Convert dots to commas in timestamps for SRT
  text = text.replace(/(\d{1,2}:\d{2}:\d{2})\.(\d{3})/g, '$1,$2').replace(/(\d{2}:\d{2})\.(\d{3})/g, '$1,$2');

  // Ensure first line starts strictly with numeric cue index 1
  const firstCueIndex = text.search(/(\d{1,2}:\d{2}:\d{2},\d{2,3})\s*-->/);
  if (firstCueIndex !== -1) {
    text = `1\n${text.substring(firstCueIndex)}`;
  } else if (text.split('\n')[0].trim().includes('-->')) {
    text = `1\n${text}`;
  }

  return { content: text, format: 'srt', valid: true };
}

/**
 * Sends subtitle text to player with mandatory CORS and Content-Type headers.
 */
export function sendSubtitleResponse(
  res: Response,
  text: string,
  format: 'srt' | 'vtt',
  filename: string,
  cacheControl = 'public, max-age=86400'
): void {
  const contentType = format === 'vtt' ? 'text/vtt; charset=utf-8' : 'text/plain; charset=utf-8';
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
  res.setHeader('Cache-Control', cacheControl);
  res.send(text);
}

/**
 * Generic proxy endpoint: downloads remote subtitles (including .zip and .gz archives from SubDL / Subsource)
 * from the allowed subtitle sites, decompresses, decodes the charset to UTF-8 and serves valid text with CORS.
 * The URL comes from the `url` query parameter or, on legacy links, from base64 in the `:data` path segment.
 */
export async function handleUnifiedSubtitleProxy(req: Request, res: Response): Promise<void> {
  let targetUrl = (req.query.url as string) || '';

  if (!targetUrl && req.params.data) {
    const normalized = req.params.data.replace(/-/g, '+').replace(/_/g, '/');
    targetUrl = Buffer.from(normalized, 'base64').toString('utf8');
  }

  if (!targetUrl || !isAllowedDownloadUrl(targetUrl)) {
    sendError(res, 400, 'Subtitle download URL is missing or not from an allowed subtitle site.');
    return;
  }

  let rawFilename = (req.query.filename as string) || '';
  if (!rawFilename) {
    try {
      rawFilename = path.basename(new URL(targetUrl).pathname);
    } catch {
      rawFilename = '';
    }
  }
  if (!rawFilename || rawFilename === '/' || rawFilename === '.') {
    rawFilename = 'subtitle.srt';
  }
  const preferredFormat: 'srt' | 'vtt' = rawFilename.toLowerCase().endsWith('.vtt') || targetUrl.toLowerCase().endsWith('.vtt')
    ? 'vtt'
    : 'srt';

  try {
    const requestHeaders: Record<string, string> = {
      // the sites read as web pages answer a common browser as they answer people (checked from Render)
      'User-Agent': siteOf(new URL(targetUrl).hostname.toLowerCase(), WEB_PAGE_SITES) ? BROWSER_UA : BROWSER_USER_AGENT,
      'Accept': '*/*'
    };
    const apiKey = (req.query.apiKey as string) || (req.query.key as string);
    if (apiKey) {
      requestHeaders['X-API-Key'] = apiKey;
      requestHeaders['Api-Key'] = apiKey;
    }
    // a Referer: the page given with the link (same site only) or the site's home page, for the sites that need one
    const targetHost = new URL(targetUrl).hostname.toLowerCase();
    const refererSite = siteOf(targetHost, Object.keys(REFERER_REQUIRED));
    if (refererSite) {
      const given = typeof req.query.ref === 'string' ? req.query.ref : '';
      let sameSite = false;
      try { sameSite = Boolean(given) && siteOf(new URL(given).hostname.toLowerCase(), [refererSite]) === refererSite; } catch { sameSite = false; }
      requestHeaders['Referer'] = sameSite ? given : REFERER_REQUIRED[refererSite];
    }

    const upstreamRes = await axios.get<ArrayBuffer>(targetUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: requestHeaders
    });

    // The list links carry what is being played, so a season pack yields the right episode
    const toNumber = (v: unknown): number | null => {
      const n = parseInt(String(v ?? ''), 10);
      return isNaN(n) ? null : n;
    };
    const pick: ArchivePick = {
      season: toNumber(req.query.season),
      episode: toNumber(req.query.episode),
      videoFilename: typeof req.query.vf === 'string' ? req.query.vf : null
    };
    const raw = Buffer.from(upstreamRes.data);
    const romanian = Boolean(siteOf(targetHost, ROMANIAN_HOSTS));
    const isRar = raw.length > 4 && raw[0] === 0x52 && raw[1] === 0x61 && raw[2] === 0x72 && raw[3] === 0x21;
    let validation: ReturnType<typeof validateAndFormatSubtitle>;
    let extractedFilename: string | undefined;
    if (isRar || romanian) {
      // RAR archives (Titrari.ro) and the Romanian sites' old files: the same handling as RegieLive's
      const r = await subtitleFromRegieLiveArchive(raw, pick);
      validation = { valid: r.valid, content: r.content, format: 'srt', reason: r.reason } as ReturnType<typeof validateAndFormatSubtitle>;
      extractedFilename = r.filename;
    } else {
      const { buffer: cleanBuffer, formatHint, filename } = decompressBuffer(raw, pick);
      validation = validateAndFormatSubtitle(toCleanUtf8(cleanBuffer), formatHint || preferredFormat);
      extractedFilename = filename;
    }

    if (!validation.valid) {
      Logger.warn(`Invalid subtitle delivered from ${new URL(targetUrl).hostname}: ${validation.reason}`);
      sendError(res, 502, `Failed to process the subtitle from the remote server: ${validation.reason}`);
      return;
    }

    sendSubtitleResponse(res, validation.content, validation.format, extractedFilename || rawFilename);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    noteRefusal(new URL(targetUrl).hostname, statusOf(err), errorMsg);
    Logger.error(`Subtitle proxy fetch failed for ${new URL(targetUrl).hostname}: ${errorMsg}`, err);
    sendError(res, 502, `Could not reach the subtitle provider: ${errorMsg}`);
  }
}

/** The hosts an OpenSubtitles download can come from (API, then mirrors) */
export const OPENSUBTITLES_SOURCES = ['api.opensubtitles.com', 'dl.opensubtitles.org', 'subs5.strem.io'];

/** Can this server download from OpenSubtitles right now (at least one way is not refusing it)? */
export const openSubtitlesDownloadable = (): boolean => OPENSUBTITLES_SOURCES.some(s => !isBlocked(s));

/**
 * Can this server download the subtitle right now? (Subsync needs the file itself.) False only when every way to it
 * is known to refuse this server for now: an OpenSubtitles quota reached, a host answering 403/469...
 */
export function serverCanDownload(item: { url: string }): boolean {
  const url = item.url;
  if (url.startsWith('/proxy/download/os-rest/')) return openSubtitlesDownloadable();
  try {
    if (url.startsWith('/sub/proxy?')) {
      const inner = new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('url');
      return !inner || !isBlocked(new URL(inner).hostname);
    }
    if (url.startsWith('/')) return true;
    return !isBlocked(new URL(url).hostname);
  } catch {
    return true;
  }
}

/** Short reason of a failed request: HTTP status and, when the provider explains it, its message (quota, reset time) */
function failureReason(err: unknown): string {
  const e = err as { response?: { status?: number; data?: unknown }; message?: string };
  if (!e?.response?.status) return e?.message || String(err);
  let detail = '';
  const data = e.response.data;
  try {
    const body = data instanceof ArrayBuffer || Buffer.isBuffer(data) ? JSON.parse(Buffer.from(data as ArrayBuffer).toString('utf8')) : data;
    if (body && typeof body === 'object') {
      const b = body as { message?: unknown; remaining?: unknown; reset_time?: unknown; reset_time_utc?: unknown };
      detail = [b.message, b.remaining !== undefined ? `remaining ${b.remaining}` : '', b.reset_time_utc || b.reset_time ? `reset ${b.reset_time_utc || b.reset_time}` : '']
        .filter(Boolean).map(String).join(', ');
    }
  } catch { /* not JSON */ }
  return `HTTP ${e.response.status}${detail ? ` (${detail.slice(0, 200)})` : ''}`;
}

/**
 * OpenSubtitles download: asks POST /api/v1/download for a temporary link and, if that fails
 * (no user token, quota reached), falls back to the OpenSubtitles direct download mirrors.
 * With mirrorFirst=1 (Subsync references) the mirrors are tried first, to keep the API quota for the user's picks.
 */
export async function handleOpenSubtitlesRestDownload(req: Request, res: Response): Promise<void> {
  const { fileId } = req.params;
  const apiKey = req.query.apiKey as string;
  const legacyId = (req.query.legacyId as string) || '';
  const filename = (req.query.filename as string) || `subtitle-${fileId}.srt`;
  const preferredFormat: 'srt' | 'vtt' = filename.toLowerCase().endsWith('.vtt') ? 'vtt' : 'srt';
  const mirrorFirst = req.query.mirrorFirst === '1';

  if (!fileId || !/^\d+$/.test(fileId)) {
    sendError(res, 400, 'Invalid or missing OpenSubtitles file id.');
    return;
  }

  let rawBuffer: Buffer | null = null;
  const failures: string[] = [];

  // 1. Official API: POST /api/v1/download returns a temporary link
  const fromApi = async (): Promise<Buffer | null> => {
    if (!apiKey) return null;
    if (isBlocked('api.opensubtitles.com')) {
      failures.push('api: skipped (refusing this server for now)');
      return null;
    }
    try {
      const downloadRes = await axios.post<{ link: string }>(
        'https://api.opensubtitles.com/api/v1/download',
        { file_id: parseInt(fileId, 10) },
        {
          headers: {
            'Api-Key': apiKey,
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 7000
        }
      );
      if (!downloadRes.data?.link) {
        failures.push('api: no download link');
        return null;
      }
      const subRes = await axios.get<ArrayBuffer>(downloadRes.data.link, {
        responseType: 'arraybuffer',
        timeout: 10000,
        headers: { 'User-Agent': BROWSER_USER_AGENT, 'Accept': '*/*' }
      });
      if (subRes.data && subRes.data.byteLength > 0) return Buffer.from(subRes.data);
      failures.push('api: empty file');
    } catch (err) {
      const reason = failureReason(err);
      failures.push(`api: ${reason}`);
      const body = (err as { response?: { data?: { message?: string; reset_time_utc?: string } } })?.response?.data;
      noteRefusal('api.opensubtitles.com', statusOf(err), reason,
        recoveryFromMessage(typeof body === 'object' ? body?.message : undefined, typeof body === 'object' ? body?.reset_time_utc : undefined));
    }
    return null;
  };

  // 2. Fallback: dl.opensubtitles.org / subs5.strem.io mirrors
  const fromMirrors = async (): Promise<Buffer | null> => {
    const candidateUrls: string[] = [];
    if (/^\d+$/.test(legacyId)) {
      candidateUrls.push(`https://dl.opensubtitles.org/en/download/sub/${legacyId}`);
    }
    candidateUrls.push(`https://dl.opensubtitles.org/en/download/sub/${fileId}`);
    candidateUrls.push(`https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/${fileId}`);

    const legacyUrl = /^\d+$/.test(legacyId) ? candidateUrls[0] : null;
    for (const mirrorUrl of candidateUrls) {
      const host = new URL(mirrorUrl).hostname;
      const label = `${host}${mirrorUrl === legacyUrl ? ' (legacy id)' : ''}`;
      if (isBlocked(host)) {
        failures.push(`${label}: skipped (refusing this server for now)`);
        continue;
      }
      try {
        const mirrorRes = await axios.get<ArrayBuffer>(mirrorUrl, {
          responseType: 'arraybuffer',
          timeout: 10000,
          headers: { 'User-Agent': BROWSER_USER_AGENT, 'Accept': '*/*' }
        });
        if (mirrorRes.data && mirrorRes.data.byteLength > 50) {
          const tempBuf = Buffer.from(mirrorRes.data);
          const preview = tempBuf.subarray(0, 100).toString('utf8').toLowerCase();
          if (!preview.includes('<!doctype') && !preview.includes('<html')) return tempBuf;
          failures.push(`${label}: a web page instead of a subtitle`);
        } else {
          failures.push(`${label}: empty answer`);
        }
      } catch (err) {
        const reason = failureReason(err);
        failures.push(`${label}: ${reason}`);
        noteRefusal(host, statusOf(err), reason);
      }
    }
    return null;
  };

  rawBuffer = mirrorFirst ? (await fromMirrors()) || (await fromApi()) : (await fromApi()) || (await fromMirrors());
  if (rawBuffer && failures.length) {
    Logger.info(`[DOWNLOAD] OpenSubtitles file ${fileId} downloaded after: ${failures.join('; ')}`);
  }

  if (!rawBuffer) {
    const summary = failures.join('; ') || 'no source';
    Logger.error(`OpenSubtitles download failed for file ${fileId}${mirrorFirst ? ' (Subsync reference)' : ''}: ${summary}`);
    sendError(res, 502, `Error downloading the subtitle from OpenSubtitles: ${summary}`);
    return;
  }

  try {
    const { buffer: cleanBuffer, formatHint, filename: extractedFilename } = decompressBuffer(rawBuffer);
    const validation = validateAndFormatSubtitle(toCleanUtf8(cleanBuffer), formatHint || preferredFormat);

    if (!validation.valid) {
      Logger.warn(`Invalid subtitle delivered from OpenSubtitles for file ${fileId}: ${validation.reason}`);
      sendError(res, 502, `Failed to process the OpenSubtitles subtitle: ${validation.reason}`);
      return;
    }

    sendSubtitleResponse(res, validation.content, validation.format, extractedFilename || filename);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    Logger.error(`OpenSubtitles subtitle parsing failed for file ${fileId}: ${errorMsg}`, err);
    sendError(res, 502, `Error processing the OpenSubtitles subtitle: ${errorMsg}`);
  }
}

const convertedSubtitles = new LRUCache<string, string>({ max: 200, ttl: 4 * 60 * 60 * 1000 });

/**
 * GET /:config/sub/convert/<base64url of the address>.srt  (or the older ?url= form)  Downloads a subtitle (normally a .vtt served by an imported addon) and
 * returns it as plain SRT, so the player applies its own size/position settings. The URL must belong to a subtitle
 * site or to an addon imported in that configuration. If anything fails the player is sent to the original link.
 */
export async function handleVttConvert(req: Request, res: Response): Promise<void> {
  const encoded = typeof req.params.data === 'string' ? Buffer.from(req.params.data, 'base64url').toString('utf8') : '';
  const original = encoded || String(req.query.url || '');
  const config = await configStorage.getConfigByUuidAsync(String(req.params.config || ''));
  const hosts = config ? addonHostsOf(config) : [];

  if (!config || !isAllowedDownloadUrl(original, hosts)) {
    sendError(res, 400, 'Subtitle URL is missing or not from a subtitle site or an addon of this configuration.');
    return;
  }

  try {
    let srt = convertedSubtitles.get(original);
    if (srt === undefined) {
      const upstream = await axios.get<ArrayBuffer>(original, {
        responseType: 'arraybuffer',
        timeout: 15000,
        maxContentLength: MAX_SUBTITLE_BYTES,
        maxRedirects: 3,
        // a redirect must not lead outside the allowed hosts
        beforeRedirect: (options: { hostname?: string }) => {
          if (!options.hostname || !isAllowedHost(options.hostname, hosts)) {
            throw new Error('Redirect to a host that is not allowed');
          }
        },
        headers: { 'User-Agent': USER_AGENT, 'Accept': '*/*' }
      });
      const { buffer } = decompressBuffer(Buffer.from(upstream.data));
      const validation = validateAndFormatSubtitle(toCleanUtf8(buffer), 'srt');
      if (!validation.valid) {
        throw new Error(validation.reason);
      }
      srt = validation.content;
      convertedSubtitles.set(original, srt);
    }
    sendSubtitleResponse(res, srt, 'srt', 'subtitle.srt');
  } catch (err: unknown) {
    Logger.warn('VTT -> SRT conversion failed, sending the player to the original link', { reason: err instanceof Error ? err.message : String(err) });
    res.redirect(302, original);
  }
}

// ---------------------------------------------------------------------------
// RegieLive downloads: ZIP or RAR archives (the type is only known from the first bytes), old Romanian
// charsets, and sometimes MicroDVD (".sub") subtitles
// ---------------------------------------------------------------------------

/** Extracts the subtitle bytes from a RAR archive, choosing the entry like pickArchiveEntry does for ZIP */
async function extractFromRar(buf: Buffer, pick?: ArchivePick): Promise<{ buffer: Buffer; filename: string }> {
  const { createExtractorFromData } = await import('node-unrar-js');
  const data = Uint8Array.from(buf).buffer;
  const extractor = await createExtractorFromData({ data });
  const headers = [...extractor.getFileList().fileHeaders].filter(
    h => !h.flags.directory && !h.flags.encrypted && h.unpSize <= MAX_SUBTITLE_BYTES
  );
  const chosen = pickArchiveEntry(headers.map(h => ({ entryName: h.name })), pick);
  if (!chosen) throw new Error('The RAR archive has no usable file.');

  const extracted = extractor.extract({ files: [chosen.entryName] });
  const file = [...extracted.files][0];
  if (!file || !file.extraction || file.extraction.length > MAX_SUBTITLE_BYTES) {
    throw new Error('Could not extract the subtitle from the RAR archive.');
  }
  return { buffer: Buffer.from(file.extraction), filename: path.basename(chosen.entryName) };
}

/** Turns a downloaded RegieLive archive (ZIP / RAR / plain file) into subtitle text in SRT form */
export async function subtitleFromRegieLiveArchive(
  archive: Buffer,
  pick?: ArchivePick
): Promise<{ content: string; filename: string; valid: boolean; reason?: string }> {
  let bytes: Buffer;
  let filename = 'subtitle.srt';

  const isRar = archive.length > 4 && archive[0] === 0x52 && archive[1] === 0x61 && archive[2] === 0x72 && archive[3] === 0x21;
  if (isRar) {
    const rar = await extractFromRar(archive, pick);
    bytes = rar.buffer;
    filename = rar.filename;
  } else {
    const plain = decompressBuffer(archive, pick);
    bytes = plain.buffer;
    filename = plain.filename || filename;
  }

  let text = toCleanUtf8(bytes, 'win1250');
  if (isMicroDvd(text)) text = microDvdToSrt(text);

  const validation = validateAndFormatSubtitle(text, 'srt');
  return { content: validation.content, filename, valid: validation.valid, reason: validation.reason };
}

/**
 * GET /proxy/download/regielive/<ticket>  Downloads the archive chosen at search time (the ticket carries its address,
 * the RegieLive session cookie and what is being played) and serves the right subtitle from it as SRT.
 */
export async function handleRegieLiveDownload(req: Request, res: Response): Promise<void> {
  const ticket = decodeTicket(String(req.params.data || ''));
  let url: URL | null = null;
  try {
    url = ticket ? new URL(ticket.u) : null;
  } catch {
    url = null;
  }
  if (!ticket || !url || url.protocol !== 'https:' || url.hostname !== REGIELIVE_DOWNLOAD_HOST) {
    sendError(res, 400, 'Invalid RegieLive download link.');
    return;
  }

  const headers = regieLiveHeaders(regieLiveApiKey(), ticket.c);
  headers.Accept = 'application/octet-stream, */*';
  const retryDelays = [1500, 3000];

  try {
    let response: { data: ArrayBuffer } | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await axios.get<ArrayBuffer>(url.toString(), {
          responseType: 'arraybuffer',
          timeout: 15000,
          headers,
          maxContentLength: 20 * 1024 * 1024,
          maxRedirects: 0
        });
        break;
      } catch (err) {
        // 429 is RegieLive's temporary rate limit: a short wait usually fixes it
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        if (status !== 429 || attempt >= retryDelays.length) throw err;
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
      }
    }

    const result = await subtitleFromRegieLiveArchive(Buffer.from(response.data), {
      season: ticket.s ?? null,
      episode: ticket.e ?? null,
      videoFilename: ticket.vf ?? null
    });
    if (!result.valid) {
      Logger.warn(`Invalid subtitle from RegieLive: ${result.reason}`);
      sendError(res, 502, `Failed to process the RegieLive subtitle: ${result.reason}`);
      return;
    }
    sendSubtitleResponse(res, result.content, 'srt', result.filename);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    Logger.error(`RegieLive download failed: ${msg}`, err);
    sendError(res, 502, `Could not download from RegieLive: ${msg}`);
  }
}
