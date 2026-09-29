import { Request, Response } from 'express';
import axios from 'axios';
import AdmZip from 'adm-zip';
import iconv from 'iconv-lite';
import zlib from 'zlib';
import path from 'path';
import { Logger } from '../utils/logger';
import { subsroGet } from '../utils/subsroHttp';

/** A subtitle is a small text file: anything bigger inside an archive is ignored (protects the server's memory) */
const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024;

const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) subs2b/1.0.0';

/** Sites the generic proxy is allowed to download from (prevents it from being used as an open proxy) */
const ALLOWED_DOWNLOAD_HOSTS = ['subdl.com', 'subsource.net', 'opensubtitles.org', 'opensubtitles.com', 'strem.io'];

export function isAllowedDownloadUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase();
    return ALLOWED_DOWNLOAD_HOSTS.some(allowed => host === allowed || host.endsWith('.' + allowed));
  } catch {
    return false;
  }
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
export function decompressBuffer(input: Buffer): { buffer: Buffer; formatHint?: 'srt' | 'vtt'; filename?: string } {
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

        const subEntry = validEntries.find(e => e.entryName.toLowerCase().endsWith('.srt'))
          || validEntries.find(e => e.entryName.toLowerCase().endsWith('.vtt'))
          || validEntries[0];

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
export function toCleanUtf8(buffer: Buffer): string {
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
    text = utf8.includes('�') ? iconv.decode(buffer, 'win1252') : utf8;
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
  const timingRegex = /(\d{1,2}:\d{2}:\d{2}[,.]\d{2,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{2,3})/;
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
  if (text.startsWith('WEBVTT')) {
    // Strip WEBVTT header and NOTE blocks
    text = text.replace(/^WEBVTT[^\n]*\n+/i, '').replace(/^NOTE[^\n]*\n+/gm, '').trim();
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
  filename: string
): void {
  const contentType = format === 'vtt' ? 'text/vtt; charset=utf-8' : 'text/plain; charset=utf-8';
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
  res.setHeader('Cache-Control', 'public, max-age=86400');
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

    const { buffer: cleanBuffer, formatHint, filename: extractedFilename } = decompressBuffer(Buffer.from(upstreamRes.data));
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
            'User-Agent': 'subs2b v1.0.0',
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

/**
 * Picks the subtitle file inside a Subs.ro ZIP archive.
 * For series, prefers the file whose name matches the requested season/episode.
 */
export function pickSubsRoEntry(zip: AdmZip, season: number | null, episode: number | null): AdmZip.IZipEntry | null {
  const entries = zip.getEntries().filter(e =>
    !e.isDirectory &&
    e.header.size <= MAX_SUBTITLE_BYTES &&
    !e.entryName.includes('__MACOSX') &&
    !path.basename(e.entryName).startsWith('.') &&
    /\.(srt|vtt)$/i.test(e.entryName)
  );
  if (entries.length === 0) return null;
  if (season === null || episode === null) return entries[0];

  const patterns = [
    new RegExp('s0*' + season + '[\\s._-]*e0*' + episode + '(?!\\d)', 'i'),
    new RegExp('(?<!\\d)0*' + season + 'x0*' + episode + '(?!\\d)', 'i'),
    new RegExp('(?:^|[^a-z0-9])e0*' + episode + '(?!\\d)', 'i'),
    new RegExp('(?:episod(?:ul)?|episode|ep)[\\s._-]*0*' + episode + '(?!\\d)', 'i')
  ];
  for (const re of patterns) {
    const hit = entries.find(e => re.test(path.basename(e.entryName)));
    if (hit) return hit;
  }
  // A pack with several files and no match for this episode: refuse rather than serve a wrong episode
  return entries.length === 1 ? entries[0] : null;
}

/**
 * Subs.ro download: GET https://api.subs.ro/v1.0/subtitle/{id}/download (X-Subs-Api-Key),
 * returns an archive; extracts the right .srt (episode-aware) and serves it as UTF-8 text.
 */
export async function handleSubsRoDownload(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const apiKey = (req.query.apiKey as string) || '';
  const filename = (req.query.filename as string) || `subsro-${id}.srt`;
  const season = req.query.season ? parseInt(String(req.query.season), 10) : null;
  const episode = req.query.episode ? parseInt(String(req.query.episode), 10) : null;

  if (!id || !/^\d+$/.test(id)) {
    sendError(res, 400, 'Invalid Subs.ro subtitle id.');
    return;
  }
  if (!apiKey) {
    sendError(res, 401, 'Subs.ro API key missing.');
    return;
  }

  try {
    const upstream = await subsroGet<ArrayBuffer>(`https://api.subs.ro/v1.0/subtitle/${id}/download`, apiKey, {
      responseType: 'arraybuffer',
      timeout: 20000
    });

    let buffer: Buffer = Buffer.from(upstream.data);
    let finalFilename = filename;

    if (buffer[0] === 0x52 && buffer[1] === 0x61 && buffer[2] === 0x72) {
      Logger.warn(`Subs.ro subtitle ${id} is a RAR archive (not supported yet)`);
      sendError(res, 415, 'This Subs.ro subtitle is a RAR archive, which is not supported yet.');
      return;
    }

    if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
      const entry = pickSubsRoEntry(new AdmZip(buffer), season, episode);
      if (!entry) {
        Logger.warn(`Subs.ro subtitle ${id}: no file for S${season}E${episode} inside archive`);
        sendError(res, 404, 'No matching episode found inside the Subs.ro archive.');
        return;
      }
      buffer = entry.getData();
      finalFilename = path.basename(entry.entryName);
    }

    const format: 'srt' | 'vtt' = finalFilename.toLowerCase().endsWith('.vtt') ? 'vtt' : 'srt';
    const validation = validateAndFormatSubtitle(toCleanUtf8(buffer), format);
    if (!validation.valid) {
      Logger.warn(`Invalid Subs.ro subtitle ${id}: ${validation.reason}`);
      sendError(res, 502, `Failed to process the Subs.ro subtitle: ${validation.reason}`);
      return;
    }

    sendSubtitleResponse(res, validation.content, validation.format, finalFilename);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    Logger.error(`Subs.ro download failed for ${id}: ${msg}`, err);
    sendError(res, 502, `Error downloading from Subs.ro: ${msg}`);
  }
}
