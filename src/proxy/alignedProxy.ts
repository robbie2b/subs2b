import { Request, Response } from 'express';
import { configStorage } from '../storage/configStore';
import { Logger } from '../utils/logger';
import { applyAlignment } from '../utils/subsync';
import { parseSubtitleQuery } from '../core/aggregator';
import { decodeAlignedToken, decodeFallbackToken, linksOf } from '../core/alignedToken';
import { recordAlignment, AlignmentResult } from '../core/alignment';
import { prepareAligned, loadFirst, clearPrepared, Served } from '../core/alignedPrepare';
import { addonHostsOf, isAllowedDownloadUrl, sendSubtitleResponse } from './subtitleProxy';

/**
 * How long the player is kept waiting for the alignment. The aligned subtitle is wanted from the first try, even
 * when it takes several seconds; only past this safety limit (something is stuck) the subtitle goes out unchanged.
 */
const maxWaitMs = (): number => parseInt(process.env.SUBSYNC_MAX_WAIT_MS || '', 10) || 60000;

const sleep = (ms: number) => new Promise<void>(resolve => { const t = setTimeout(resolve, ms); t.unref?.(); });

/**
 * GET /:config/sub/aligned/<token>.srt
 * Serves a subtitle, re-timed to a reference of the playing file's kind. The player waits for the decision (the
 * list has usually started it already); if no reference exists or something fails, the subtitle goes out unchanged.
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

    const originalFailed = (err: unknown) => {
      Logger.warn('Aligned subtitle: the original could not be loaded', { reason: err instanceof Error ? err.message : String(err) });
      if (own) {
        res.status(502).type('text/plain').send('Could not load the subtitle.');
      } else {
        res.redirect(302, token.u);
      }
    };

    if (config.subsync === false) {
      try {
        sendSubtitleResponse(res, (await loadFirst(linksOf(token), hosts, baseUrl)).text, 'srt', 'subtitle.srt');
      } catch (err: unknown) {
        originalFailed(err);
      }
      return;
    }

    // the work may already be under way: the list starts the likely choice while the player opens the video
    const query = parseSubtitleQuery(token.t || 'movie', token.id, { filename: token.f });
    const prep = prepareAligned(token, query, config, baseUrl);

    let text: string;
    try {
      text = await prep.original;
    } catch (err: unknown) {
      originalFailed(err);
      return;
    }

    const log = (outcome: 'shifted' | 'unchanged' | 'timeout' | 'error', result?: AlignmentResult, reason?: string, replacedBy?: string) => {
      recordAlignment(configKey, {
        at: new Date().toISOString(),
        id: token.id,
        filename: token.f,
        subtitle: token.r || '',
        outcome,
        offset: result?.decision.apply ? result.decision.offset : 0,
        ratio: result?.decision.apply ? result.decision.ratio : 1,
        segments: result?.decision.apply ? result.decision.segments : 0,
        confidence: result?.decision.confidence ?? 0,
        reason: reason || (result ? result.decision.reason + (result.note ? ` (${result.note})` : '') : ''),
        references: result?.references || [],
        ...(replacedBy ? { replacedBy } : {}),
        ms: Date.now() - started
      });
    };

    try {
      const raced = await Promise.race([prep.served, sleep(maxWaitMs()).then(() => 'timeout' as const)]);
      if (raced === 'timeout') {
        // safety only: the work goes on, the next request finds the answer ready
        Logger.info(`[SUBSYNC] no answer within ${maxWaitMs()} ms, sending the subtitle unchanged`, { id: token.id });
        log('timeout', undefined, `no answer within ${maxWaitMs()} ms`);
        sendSubtitleResponse(res, text, 'srt', 'subtitle.srt', 'no-store');
        return;
      }
      const served: Served = raced;
      const { result, replacedBy } = served;
      // the player asks for the same subtitle again and again (seeking, switching tracks): the decision was made once
      // and is logged once; the repeats are only a short line
      if (prep.reported) {
        Logger.info(`[SUBSYNC] served again from memory (decided earlier, nothing computed)`, { id: token.id, subtitle: replacedBy || token.r });
        const again = served.text ?? text;
        sendSubtitleResponse(res, result.decision.apply ? applyAlignment(again, result.decision.result!) : again, 'srt', 'subtitle.srt', 'public, max-age=3600');
        return;
      }
      prep.reported = true;
      if (served.timing) {
        const t = served.timing;
        Logger.info(`[SUBSYNC] timing for ${token.id}: subtitle ${t.original} ms, references ${t.references} ms (both from the start, in parallel), computation ${t.compute} ms; the player waited ${Date.now() - started} ms`);
      }
      const body = served.text ?? text;
      if (replacedBy) Logger.info(`[SUBSYNC] the subtitle does not fit the references, serving an alternative instead`, { id: token.id, subtitle: token.r, replacedBy });
      if (result.decision.apply) {
        const shifted = applyAlignment(body, result.decision.result!);
        Logger.info(`[SUBSYNC] shifted ${result.decision.offset} s${result.decision.ratio !== 1 ? ` x${result.decision.ratio}` : ''}${result.decision.segments > 1 ? ` in ${result.decision.segments} parts` : ''} (${result.decision.reason})`, { id: token.id, subtitle: replacedBy || token.r });
        log('shifted', result, undefined, replacedBy);
        sendSubtitleResponse(res, shifted, 'srt', 'subtitle.srt', 'public, max-age=3600');
      } else {
        log('unchanged', result, undefined, replacedBy);
        sendSubtitleResponse(res, body, 'srt', 'subtitle.srt', 'public, max-age=3600');
      }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      Logger.warn('Subsync failed, sending the subtitle unchanged', { reason });
      log('error', undefined, reason);
      sendSubtitleResponse(res, text, 'srt', 'subtitle.srt', 'no-store');
    }
  };
}

/**
 * GET /:config/sub/fallback/<token>.srt
 * A subtitle offered by several providers: the sources are tried in order (the user's provider priority) and the
 * first that can be downloaded is served, so one provider's rate limit or outage does not lose the subtitle.
 */
export function createFallbackHandler(getBaseUrl: (req: Request) => string) {
  return async (req: Request, res: Response): Promise<void> => {
    const token = decodeFallbackToken(String(req.params.data || ''));
    const config = await configStorage.getConfigByUuidAsync(String(req.params.config || ''));
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
    try {
      const { text } = await loadFirst(linksOf(token), hosts, baseUrl);
      sendSubtitleResponse(res, text, 'srt', 'subtitle.srt', 'public, max-age=3600');
    } catch {
      // every source failed here: the player may still reach the first one itself
      if (own) res.status(502).type('text/plain').send('Could not load the subtitle from any source.');
      else res.redirect(302, token.u);
    }
  };
}

export function clearAlignmentDecisions(): void {
  clearPrepared();
}
