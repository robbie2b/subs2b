import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { Logger } from './logger';
import { ENV } from '../config/env';
import { USER_AGENT } from '../config/version';

// Subs.ro sits behind Cloudflare, which may challenge some clients. We try a few
// User-Agents (the official example script's first) and remember the one that works.
const USER_AGENTS = [
  'Subs.ro API Test Script',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  USER_AGENT
];

let workingIndex = 0;

function isCloudflareChallenge(res: { data?: unknown; headers?: Record<string, unknown> }): boolean {
  const ct = String(res.headers?.['content-type'] || '').toLowerCase();
  if (ct.includes('text/html')) return true;
  if (typeof res.data === 'string' && /just a moment|cf-chl|cloudflare/i.test(res.data.slice(0, 500))) return true;
  return false;
}

export async function subsroGet<T = unknown>(
  url: string,
  apiKey: string,
  options: AxiosRequestConfig = {}
): Promise<AxiosResponse<T>> {
  let lastRes: AxiosResponse<T> | null = null;

  // Optional relay (e.g. Cloudflare Worker) for hosts whose IP is challenged by Subs.ro's Cloudflare
  const useRelay = Boolean(ENV.SUBSRO_PROXY_URL);
  const targetUrl = useRelay ? url.replace('https://api.subs.ro', ENV.SUBSRO_PROXY_URL) : url;

  for (let i = 0; i < USER_AGENTS.length; i++) {
    const idx = (workingIndex + i) % USER_AGENTS.length;
    const res = await axios.get<T>(targetUrl, {
      ...options,
      validateStatus: () => true,
      headers: {
        ...(options.headers || {}),
        'X-Subs-Api-Key': apiKey,
        ...(useRelay ? { 'X-Relay-Token': ENV.SUBSRO_PROXY_TOKEN } : {}),
        'User-Agent': USER_AGENTS[idx],
        'Accept': options.responseType === 'arraybuffer' ? '*/*' : 'application/json'
      }
    });

    if (!isCloudflareChallenge(res)) {
      if (idx !== workingIndex) {
        Logger.info(`[SUBSRO] Using User-Agent #${idx} (previous ones were challenged)`);
        workingIndex = idx;
      }
      if (res.status >= 400) {
        const err = new Error(`Subs.ro HTTP ${res.status}`) as Error & { response?: AxiosResponse<T> };
        err.response = res;
        throw err;
      }
      return res;
    }
    lastRes = res;
  }

  Logger.warn('[SUBSRO] All User-Agents were challenged by Cloudflare (server IP likely blocked)');
  const err = new Error('Subs.ro blocked by Cloudflare challenge') as Error & { response?: AxiosResponse<T> };
  err.response = lastRes || undefined;
  throw err;
}
