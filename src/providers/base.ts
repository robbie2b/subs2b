import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { SubtitleProvider, SubtitleQuery, ProviderContext, RawSubtitleItem, ProviderLogEntry, SearchOutcome } from '../types/provider';
import { Logger } from '../utils/logger';
import { USER_AGENT } from '../config/version';

export abstract class BaseSubtitleProvider implements SubtitleProvider {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly requiresApiKey: boolean;
  abstract readonly defaultEnabled: boolean;

  protected abstract executeSearch(
    query: SubtitleQuery,
    context: ProviderContext,
    signal: AbortSignal
  ): Promise<RawSubtitleItem[]>;

  async search(query: SubtitleQuery, context: ProviderContext): Promise<RawSubtitleItem[]> {
    return (await this.searchWithStatus(query, context)).items;
  }

  /** Like search(), but also tells the caller whether the provider failed (error / timeout / HTTP error). */
  async searchWithStatus(query: SubtitleQuery, context: ProviderContext): Promise<SearchOutcome> {
    const startTime = Date.now();
    const abortController = new AbortController();
    const timeoutMs = context.timeoutMs || 6000;
    const timeoutTimer = setTimeout(() => {
      abortController.abort(new Error(`Provider [${this.name}] timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      const items = await this.executeSearch(query, context, abortController.signal);
      clearTimeout(timeoutTimer);

      const durationMs = Date.now() - startTime;
      const logEntry: ProviderLogEntry = {
        providerId: this.id,
        durationMs,
        resultsCount: items.length,
        success: true
      };
      Logger.logProviderResult(logEntry);

      return { items, failed: false };
    } catch (err: unknown) {
      clearTimeout(timeoutTimer);
      const durationMs = Date.now() - startTime;
      // when the time limit cut the request, say so (axios only reports "canceled")
      const reason = abortController.signal.aborted ? abortController.signal.reason : null;
      const errorMessage = reason instanceof Error ? reason.message : (err instanceof Error ? err.message : String(err));

      const logEntry: ProviderLogEntry = {
        providerId: this.id,
        durationMs,
        resultsCount: 0,
        success: false,
        error: errorMessage
      };
      Logger.logProviderResult(logEntry);

      return { items: [], failed: true, error: errorMessage };
    }
  }

  protected async httpGet<T = unknown>(
    url: string,
    options: AxiosRequestConfig = {},
    signal?: AbortSignal
  ): Promise<AxiosResponse<T>> {
    const started = Date.now();
    const run = () => axios.get<T>(url, {
      ...options,
      signal,
      headers: {
        'User-Agent': `${USER_AGENT} (Stremio Addon)`,
        ...(options.headers || {})
      }
    });
    try {
      return await run();
    } catch (err: unknown) {
      // A gateway error that came back at once (a 502 in 100 ms: the addon's own proxy blinked) is tried once more; the
      // same source answered fine in the same minute. Not for 429/503 (a limit or a maintenance), and not when the
      // first try was slow (the time is the limit) or the search was already given up.
      const e = err as { response?: { status?: number }; code?: string };
      const transient = [502, 504, 520, 521, 522, 523, 524].includes(e?.response?.status ?? 0) || e?.code === 'ECONNRESET';
      if (transient && Date.now() - started < 500 && !signal?.aborted) {
        await new Promise(r => setTimeout(r, 150));
        if (!signal?.aborted) return run();
      }
      throw err;
    }
  }

  protected async httpPost<T = unknown>(
    url: string,
    data: unknown,
    options: AxiosRequestConfig = {},
    signal?: AbortSignal
  ): Promise<AxiosResponse<T>> {
    return axios.post<T>(url, data, {
      ...options,
      signal,
      headers: {
        'User-Agent': `${USER_AGENT} (Stremio Addon)`,
        ...(options.headers || {})
      }
    });
  }
}
