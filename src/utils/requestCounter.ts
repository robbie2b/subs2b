import type { AxiosStatic, InternalAxiosRequestConfig } from 'axios';

/**
 * How many requests this server makes to each host, per day (UTC): the sources have daily limits (Subs.ro: 300 a day),
 * and the numbers on their side were far above what the Debug page showed. Counted for every request made through
 * axios (searches, downloads, retries); kept in memory and handed to the store (storage/requestCountStore) in batches.
 */

const today = (): string => new Date().toISOString().slice(0, 10);

const memory = new Map<string, number>();
let pending = new Map<string, number>();
let sink: ((batch: Array<{ day: string; host: string; n: number }>) => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_MS = 3000;

/** Called by the store: gets the counts not yet saved, every few seconds of activity */
export function attachRequestCountSink(save: (batch: Array<{ day: string; host: string; n: number }>) => void): void {
  sink = save;
}

export function noteRequest(url: string | undefined): void {
  let host: string;
  try { host = new URL(url || '').hostname.toLowerCase(); } catch { return; }
  if (!host) return;
  const key = `${today()}|${host}`;
  memory.set(key, (memory.get(key) || 0) + 1);
  if (!sink) return;
  pending.set(key, (pending.get(key) || 0) + 1);
  if (!timer) {
    timer = setTimeout(() => {
      timer = null;
      const batch = [...pending.entries()].map(([k, n]) => { const [day, host] = k.split('|'); return { day, host, n }; });
      pending = new Map();
      try { sink?.(batch); } catch { /* counting must never break a request */ }
    }, FLUSH_MS);
    timer.unref?.();
  }
}

/** Counts every request of the default axios instance, once */
let installed = false;
export function installRequestCounter(axios: AxiosStatic): void {
  if (installed) return;
  installed = true;
  axios.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    try {
      const base = config.baseURL || '';
      noteRequest(/^https?:/i.test(config.url || '') ? config.url : base + (config.url || ''));
    } catch { /* ignore */ }
    return config;
  });
}

/** What this instance counted (the page uses the stored counts of all instances when there is a database) */
export function memoryRequestCounts(): Array<{ day: string; host: string; n: number }> {
  return [...memory.entries()].map(([k, n]) => { const [day, host] = k.split('|'); return { day, host, n }; });
}
