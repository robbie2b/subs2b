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

/** A subtitle is a small text file: anything bigger inside an archive is ignored (protects the server's memory) */
const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024;

const BROWSER_USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) subs2b/${APP_VERSION}`;

/** Sites the generic proxy is allowed to download from (prevents it from being used as an open proxy) */
const ALLOWED_DOWNLOAD_HOSTS = ['subdl.com', 'subsource.net', 'opensubtitles.org', 'opensubtitles.com', 'strem.io'];

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
      'User-Agent': BROWSER_USER_AGENT,
      'Accept': '*/*'
    };
    const apiKey = (req.query.apiKey as string) || (req.query.key as string);
    if (apiKey) {
      requestHeaders['X-API-Key'] = apiKey;
      requestHeaders['Api-Key'] = apiKey;
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
    const { buffer: cleanBuffer, formatHint, filename: extractedFilename } = decompressBuffer(Buffer.from(upstreamRes.data), pick);
    const validation = validateAndFormatSubtitle(toCleanUtf8(cleanBuffer), formatHint || preferredFormat);

    if (!validation.valid) {
      Logger.warn(`Invalid subtitle delivered from ${new URL(targetUrl).hostname}: ${validation.reason}`);
      sendError(res, 502, `Failed to process the subtitle from the remote server: ${validation.reason}`);
      return;
    }

    sendSubtitleResponse(res, validation.content, validation.format, extractedFilename || rawFilename);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    Logger.error(`Subtitle proxy fetch failed for ${new URL(targetUrl).hostname}: ${errorMsg}`, err);
    sendError(res, 502, `Could not reach the subtitle provider: ${errorMsg}`);
  }
}

/**
 * OpenSubtitles download: asks POST /api/v1/download for a temporary link and, if that fails
 * (no user token, quota reached), falls back to the OpenSubtitles direct download mirrors.
 */
export async function handleOpenSubtitlesRestDownload(req: Request, res: Response): Promise<void> {
  const { fileId } = req.params;
  const apiKey = req.query.apiKey as string;
  const legacyId = (req.query.legacyId as string) || '';
  const filename = (req.query.filename as string) || `subtitle-${fileId}.srt`;
  const preferredFormat: 'srt' | 'vtt' = filename.toLowerCase().endsWith('.vtt') ? 'vtt' : 'srt';

  if (!fileId || !/^\d+$/.test(fileId)) {
    sendError(res, 400, 'Invalid or missing OpenSubtitles file id.');
    return;
  }

  let rawBuffer: Buffer | null = null;
  let lastError: unknown;

  // 1. Official API: POST /api/v1/download returns a temporary link
  if (apiKey) {
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
      if (downloadRes.data?.link) {
        const subRes = await axios.get<ArrayBuffer>(downloadRes.data.link, {
          responseType: 'arraybuffer',
          timeout: 10000,
          headers: { 'User-Agent': BROWSER_USER_AGENT, 'Accept': '*/*' }
        });
        if (subRes.data && subRes.data.byteLength > 0) {
          rawBuffer = Buffer.from(subRes.data);
        }
      }
    } catch (err) {
      lastError = err;
    }
  }

  // 2. Fallback: dl.opensubtitles.org / subs5.strem.io mirrors
  if (!rawBuffer) {
    const candidateUrls: string[] = [];
    if (/^\d+$/.test(legacyId)) {
      candidateUrls.push(`https://dl.opensubtitles.org/en/download/sub/${legacyId}`);
    }
    candidateUrls.push(`https://dl.opensubtitles.org/en/download/sub/${fileId}`);
    candidateUrls.push(`https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/${fileId}`);

    for (const mirrorUrl of candidateUrls) {
      try {
        const mirrorRes = await axios.get<ArrayBuffer>(mirrorUrl, {
          responseType: 'arraybuffer',
          timeout: 10000,
          headers: { 'User-Agent': BROWSER_USER_AGENT, 'Accept': '*/*' }
        });
        if (mirrorRes.data && mirrorRes.data.byteLength > 50) {
          const tempBuf = Buffer.from(mirrorRes.data);
          const preview = tempBuf.subarray(0, 100).toString('utf8').toLowerCase();
          if (!preview.includes('<!doctype') && !preview.includes('<html')) {
            rawBuffer = tempBuf;
            break;
          }
        }
      } catch (err) {
        lastError = err;
      }
    }
  }

  if (!rawBuffer) {
    const errorMsg = lastError instanceof Error ? lastError.message : String(lastError || 'Failed to download the subtitle from OpenSubtitles');
    Logger.error(`OpenSubtitles download failed for file ${fileId}: ${errorMsg}`, lastError);
    sendError(res, 502, `Error downloading the subtitle from OpenSubtitles: ${errorMsg}`);
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
