import axios from 'axios';
import { Request, Response } from 'express';
import { LRUCache } from 'lru-cache';
import { StremioSubtitle } from '../types/stremio';
import { USER_AGENT } from '../config/version';
import { Logger } from '../utils/logger';

/**
 * A temporary test for players that show nothing (Stremio on a TV): while it is switched on (Debug page, 2 hours), the
 * first subtitle of the list is offered 4 more times, at the top, each served differently, so one try on the TV
 * tells what that player needs:
 *   1. SRT as text/plain, long link (how links were served before 1.5.2)
 *   2. SRT as text/plain, short link
 *   3. SRT as application/x-subrip, short link (how links are served since 1.5.2, but short)
 *   4. WebVTT, short link
 */

const TEST_HOURS = 2;
const switchedOn = new Map<string, number>();
const links = new LRUCache<string, string>({ max: 500, ttl: 6 * 60 * 60 * 1000 });

export function setFormatTest(configKey: string, on: boolean): void {
  if (on) switchedOn.set(configKey, Date.now() + TEST_HOURS * 60 * 60 * 1000);
  else switchedOn.delete(configKey);
}

/** Until when the test runs for this configuration (null: off) */
export function formatTestUntil(configKey: string): number | null {
  const until = switchedOn.get(configKey);
  if (!until || until < Date.now()) { switchedOn.delete(configKey); return null; }
  return until;
}

const VARIANTS = ['plain-long', 'plain', 'subrip', 'vtt'] as const;
type Variant = typeof VARIANTS[number];

/** The 4 test entries for one subtitle link of this server */
export function formatTestEntries(baseUrl: string, configId: string, url: string, lang: string): StremioSubtitle[] {
  const id = Math.random().toString(36).slice(2, 10);
  links.set(id, url);
  return VARIANTS.map((v, i) => {
    const file = v === 'vtt' ? 'sub.vtt' : 'sub.srt';
    // the long link carries padding as long as a real link with alternatives (the content is the same)
    const pad = v === 'plain-long' ? `?pad=${'x'.repeat(3500)}` : '';
    return { id: `subs2b-test-${i + 1}`, lang, url: `${baseUrl}/${configId}/sub/test/${id}/${v}/${file}${pad}`, title: `TEST ${i + 1}: ${v}` };
  });
}

export function srtToVtt(srt: string): string {
  const body = srt.replace(/\r/g, '').replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2').trim();
  return `WEBVTT\n\n${body}\n`;
}

/** GET /:config/sub/test/:id/:variant/:file */
export function createFormatTestHandler(getBaseUrl: (req: Request) => string) {
  return async (req: Request, res: Response): Promise<void> => {
    const url = links.get(String(req.params.id || ''));
    const variant = String(req.params.variant || '') as Variant;
    const baseUrl = getBaseUrl(req);
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!url || !VARIANTS.includes(variant) || !url.startsWith(baseUrl + '/')) {
      res.status(404).type('text/plain').send('Test link expired.');
      return;
    }
    try {
      const upstream = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: 70000, headers: { 'User-Agent': USER_AGENT } });
      const srt = Buffer.from(upstream.data).toString('utf8');
      Logger.info(`[FORMAT TEST] variant ${VARIANTS.indexOf(variant) + 1} (${variant}) requested by the player`, { userAgent: req.get('user-agent') || '' });
      res.setHeader('Cache-Control', 'no-store');
      if (variant === 'vtt') {
        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.send(srtToVtt(srt));
      } else {
        res.setHeader('Content-Type', variant === 'subrip' ? 'application/x-subrip; charset=utf-8' : 'text/plain; charset=utf-8');
        res.send(srt);
      }
    } catch (err: unknown) {
      res.status(502).type('text/plain').send(`Could not load the subtitle: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
