import { Request, Response } from 'express';
import axios from 'axios';
import { LRUCache } from 'lru-cache';
import { configStorage } from '../storage/configStore';
import { Logger } from '../utils/logger';
import { USER_AGENT } from '../config/version';
import { shiftSubtitle } from '../utils/subtitleFormat';
import { parseSubtitleQuery } from '../core/aggregator';
import { decodeAlignedToken } from '../core/alignedToken';
import { alignAgainst, getReferences, recordAlignment, AlignmentResult } from '../core/alignment';
import {
  addonHostsOf, isAllowedDownloadUrl, decompressBuffer, toCleanUtf8, validateAndFormatSubtitle, sendSubtitleResponse
} from './subtitleProxy';

/** How long the player may wait for the alignment before it gets the subtitle unchanged */
const budgetMs = (): number => parseInt(process.env.SUBSYNC_BUDGET_MS || '', 10) || 5000;

const decisions = new LRUCache<string, AlignmentResult>({ max: 500, ttl: 6 * 60 * 60 * 1000 });

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Downloads the original subtitle and returns it as clean SRT text */
async function loadOriginal(url: string, allowedHosts: string[]): Promise<string> {
  const origin = new URL(url).origin;
  const upstream = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    timeout: 15000,
    maxContentLength: 10 * 1024 * 1024,
    maxRedirects: 3,
    beforeRedirect: (options: { href?: string }) => {
      // a redirect must stay on an allowed host (or on this server)
      const target = options.href || '';
      if (!isAllowedDownloadUrl(target, allowedHosts) && !target.startsWith(origin + '/')) {
        throw new Error('Redirect to a host that is not allowed');
      }
    },
    headers: { 'User-Agent': USER_AGENT, Accept: '*/*' }
  });
  const { buffer } = decompressBuffer(Buffer.from(upstream.data));
  const validation = validateAndFormatSubtitle(toCleanUtf8(buffer), 'srt');
  if (!validation.valid) throw new Error(validation.reason || 'invalid subtitle');
  return validation.content;
}

/**
 * GET /:config/sub/aligned/<token>.srt
 * Serves a subtitle, re-timed to a reference of the playing file's kind when one is found in time.
 * Whatever goes wrong, the player gets the subtitle unchanged.
 */
export function createAlignedHandler(getBaseUrl: (req: Request) => string) {
  return async (req: Request, res: Response): Promise<void> => {
    const started = Date.now();
    const token = decodeAlignedToken(String(req.params.data || ''));
    const configKey = String(req.params.config || '');
    const config = await configStorage.getConfigByUuidAsync(configKey);
    const baseUrl = getBaseUrl(req);

    if (!token || !config) {
      res.status(400).type('text/plain').send('Invalid subtitle link.');
      return;
    }
    const hosts = addonHostsOf(config);
    const own = token.u.startsWith(baseUrl + '/');
    if (!own && !isAllowedDownloadUrl(token.u, hosts)) {
      res.status(400).type('text/plain').send('Subtitle URL is not from this server, a subtitle site or an addon of this configuration.');
      return;
    }

    let text: string;
    try {
      text = await loadOriginal(token.u, hosts);
    } catch (err: unknown) {
      Logger.warn('Aligned subtitle: the original could not be loaded', { reason: err instanceof Error ? err.message : String(err) });
      if (own) {
        res.status(502).type('text/plain').send('Could not load the subtitle.');
      } else {
        res.redirect(302, token.u);
      }
      return;
    }

    const log = (outcome: 'shifted' | 'unchanged' | 'timeout' | 'error', result?: AlignmentResult, reason?: string) => {
      recordAlignment(configKey, {
        at: new Date().toISOString(),
        id: token.id,
        filename: token.f,
        subtitle: token.r || '',
        outcome,
        offset: result?.decision.apply ? result.decision.offset : 0,
        confidence: result?.decision.confidence ?? 0,
        reason: reason || result?.decision.reason || '',
        references: result?.references || [],
        ms: Date.now() - started
      });
    };

    if (config.subsync === false) {
      sendSubtitleResponse(res, text, 'srt', 'subtitle.srt');
      return;
    }

    try {
      const cacheKey = `${token.u}|${token.f}`;
      let result = decisions.get(cacheKey);
      if (!result) {
        const query = parseSubtitleQuery(token.t || 'movie', token.id, { filename: token.f });
        const work = getReferences({ query, config, baseUrl, filename: token.f })
          .then(refs => alignAgainst(text, refs));
        const raced = await Promise.race([work, sleep(budgetMs()).then(() => 'timeout' as const)]);
        if (raced === 'timeout') {
          // keep working in the background: the next request finds the answer ready
          work.then(r => decisions.set(cacheKey, r)).catch(() => undefined);
          Logger.info(`[SUBSYNC] over budget (${budgetMs()} ms), sending the subtitle unchanged`, { id: token.id });
          log('timeout', undefined, `no answer within ${budgetMs()} ms`);
          sendSubtitleResponse(res, text, 'srt', 'subtitle.srt', 'no-store');
          return;
        }
        result = raced;
        decisions.set(cacheKey, result);
      }

      if (result.decision.apply) {
        const shifted = shiftSubtitle(text, result.decision.offset);
        Logger.info(`[SUBSYNC] shifted ${result.decision.offset} s (${result.decision.reason})`, { id: token.id, subtitle: token.r });
        log('shifted', result);
        sendSubtitleResponse(res, shifted, 'srt', 'subtitle.srt', 'public, max-age=3600');
      } else {
        log('unchanged', result);
        sendSubtitleResponse(res, text, 'srt', 'subtitle.srt', 'public, max-age=3600');
      }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      Logger.warn('Subsync failed, sending the subtitle unchanged', { reason });
      log('error', undefined, reason);
      sendSubtitleResponse(res, text, 'srt', 'subtitle.srt', 'no-store');
    }
  };
}

export function clearAlignmentDecisions(): void {
  decisions.clear();
}
