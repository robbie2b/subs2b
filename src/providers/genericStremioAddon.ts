import { BaseSubtitleProvider } from './base';
import { SubtitleQuery, ProviderContext, RawSubtitleItem } from '../types/provider';
import { shortHash } from '../utils/ids';

interface GenericStremioSubtitleItem {
  url: string;
  lang: string;
  file?: string;
  title?: string;
}

interface GenericStremioSubtitlesResponse {
  subtitles?: GenericStremioSubtitleItem[];
}

/**
 * What the player tells an addon about the file, in the Stremio path form ("videoHash=..&videoSize=..&filename=.."):
 * addons use it to put the subtitles made for this exact file first (OpenSubtitles by the file's hash). Without it an
 * imported addon answers as for any copy of the film. Empty when the player sent none of it.
 */
export function extraPathOf(query: SubtitleQuery): string {
  const extra = query.extra || {};
  return ['videoHash', 'videoSize', 'filename']
    .filter(key => typeof extra[key] === 'string' && String(extra[key]).trim() !== '')
    .map(key => `${key}=${encodeURIComponent(String(extra[key]))}`)
    .join('&');
}

/**
 * Some addons (e.g. the community Subs.ro addon) put the real subtitle file name in the URL,
 * base64url-encoded (.../proxy/<id>/<encoded-name>/sub.vtt). Decode it to recover the release name.
 */
export function decodeReleaseFromUrl(rawUrl: string): string | null {
  try {
    const segments = new URL(rawUrl).pathname.split('/').filter(Boolean);
    for (const seg of segments) {
      if (seg.length < 12 || !/^[A-Za-z0-9_-]+$/.test(seg)) continue;
      const decoded = Buffer.from(seg, 'base64url').toString('utf8');
      if (decoded.includes('\ufffd') || /[\u0000-\u001f]/.test(decoded)) continue;
      if (!/\.(srt|vtt|ass|ssa)$/i.test(decoded)) continue;
      const parts = decoded.split(/[\\/]/);
      const base = (parts.pop() || decoded).replace(/\.(srt|vtt|ass|ssa)$/i, '');
      const folder = parts.pop();
      // The archive folder often carries the source ("WEB-DL 3 variante", "CAM", "BluRay"):
      // keep it when the file name itself does not say the source.
      if (folder && !/(web|blu|hdtc|hdts|cam|remux|hdrip|dvd|hdtv)/i.test(base)) {
        return `${base} [${folder}]`;
      }
      return base;
    }
  } catch {
    // not decodable, ignore
  }
  return null;
}

export class GenericStremioAddonProvider extends BaseSubtitleProvider {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly requiresApiKey = false;
  readonly defaultEnabled = true;
  private readonly baseUrl: string;

  constructor(addonId: string, addonName: string, manifestUrl: string) {
    super();
    this.id = addonId;
    this.name = addonName && addonName.trim() !== '' ? addonName.trim() : (addonId || 'External Addon');
    this.description = `Custom imported Stremio subtitle addon: ${this.name}`;

    let cleanUrl = manifestUrl.trim();
    if (cleanUrl.startsWith('stremio://')) {
      cleanUrl = cleanUrl.replace(/^stremio:\/\//, 'https://');
    }
    this.baseUrl = cleanUrl.replace(/\/manifest\.json$/i, '').replace(/\/+$/, '');
  }

  protected async executeSearch(
    query: SubtitleQuery,
    context: ProviderContext,
    signal: AbortSignal
  ): Promise<RawSubtitleItem[]> {
    const path = `${this.baseUrl}/subtitles/${encodeURIComponent(query.type)}/${encodeURIComponent(query.id)}`;
    const timeout = context.timeoutMs || 20000;

    // with what the player knows of the file; an addon that does not take it (a 4xx) is asked the plain way
    const extra = extraPathOf(query);
    let response: Awaited<ReturnType<typeof this.httpGet<GenericStremioSubtitlesResponse>>> | null = null;
    if (extra) {
      try {
        response = await this.httpGet<GenericStremioSubtitlesResponse>(`${path}/${extra}.json`, { timeout }, signal);
      } catch (err: unknown) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (!status || status >= 500 || status === 429) throw err;
      }
    }
    if (!response) {
      response = await this.httpGet<GenericStremioSubtitlesResponse>(`${path}.json`, { timeout }, signal);
    }

    if (!response.data || !Array.isArray(response.data.subtitles)) {
      return [];
    }

    const items: RawSubtitleItem[] = [];

    for (const sub of response.data.subtitles) {
      if (!sub.url || !sub.lang) continue;

      let release = decodeReleaseFromUrl(sub.url) || sub.file || sub.title;
      if (!release) {
        try {
          const parsed = new URL(sub.url);
          const fname = parsed.pathname.substring(parsed.pathname.lastIndexOf('/') + 1);
          if (fname && fname.includes('.')) {
            release = decodeURIComponent(fname).replace(/\.(srt|vtt|sub)$/i, '');
          }
        } catch {
          // Ignored URL parsing error
        }
      }

      if (!release) {
        release = `${this.name} Subtitle`;
      }

      const isHI = /(hearing\.impaired|\.hi\.|\[hi\]|\(hi\)|\[cc\]|\.cc\.)/i.test(release);

      items.push({
        // upstream ids can collide (same archive id + same name prefix), so the id comes from the URL
        id: `${this.id}-${shortHash(sub.url)}`,
        provider: this.id,
        providerName: this.name,
        url: sub.url,
        lang: sub.lang,
        release,
        format: sub.url.toLowerCase().endsWith('.vtt') ? 'vtt' : 'srt',
        hearingImpaired: isHI
      });
    }

    return items;
  }
}
