import { Logger } from './logger';

/**
 * Which download sources refuse this server for now (a daily quota reached, a rate limit, a block), so they are
 * not tried again and again until they recover. Kept in memory and, when a store is attached (the database), saved
 * there too, so a restart or a deploy does not forget them (forgetting an OpenSubtitles quota put a subtitle nobody
 * could download in first place).
 */

/** Where the refusals are kept beyond this process (attached at start; none in tests) */
export interface RefusalStore {
  save(source: string, until: number, reason: string): void;
}
let store: RefusalStore | null = null;
export function attachRefusalStore(s: RefusalStore | null): void { store = s; }

/** Refusals read back at start (only the ones still running) */
export function restoreRefusals(list: Array<{ source: string; until: number; reason: string }>): void {
  for (const r of list) if (r.until > Date.now()) blocks.set(r.source, { until: r.until, reason: r.reason });
}

interface Block { until: number; reason: string }

const blocks = new Map<string, Block>();

/** How long a refusal is remembered when the source does not say when it recovers */
const DEFAULT_BLOCK_MS: Record<number, number> = {
  403: 30 * 60 * 1000,
  406: 60 * 60 * 1000,   // OpenSubtitles: daily download quota reached
  429: 15 * 60 * 1000,
  469: 30 * 60 * 1000,   // subs5.strem.io: too many downloads from this server
  503: 5 * 60 * 1000
};

/** OpenSubtitles says when the quota comes back: "renewed in 15 hours and 49 minutes", or reset_time_utc */
export function recoveryFromMessage(message: string | undefined, resetUtc?: string): number | null {
  if (resetUtc) {
    const t = Date.parse(resetUtc);
    if (!isNaN(t) && t > Date.now()) return t;
  }
  const m = /renewed in (?:(\d+) hours?)?(?: and )?(?:(\d+) minutes?)?/i.exec(message || '');
  if (m && (m[1] || m[2])) return Date.now() + ((parseInt(m[1] || '0', 10) * 60) + parseInt(m[2] || '0', 10) + 1) * 60 * 1000;
  return null;
}

/** Remembers a refusal (only for the statuses that mean "not now"); returns true when it was remembered */
export function noteRefusal(source: string, status: number | undefined, reason: string, recoversAt?: number | null): boolean {
  if (!status || !(status in DEFAULT_BLOCK_MS)) return false;
  const until = recoversAt && recoversAt > Date.now() ? recoversAt : Date.now() + DEFAULT_BLOCK_MS[status];
  const known = blocks.get(source);
  blocks.set(source, { until, reason });
  if (!known || known.until < Date.now()) {
    Logger.warn(`[SOURCES] ${source} refuses this server until ${new Date(until).toISOString()} (${reason})`);
  }
  store?.save(source, until, reason);
  return true;
}

/** Is the source refusing this server right now? */
export function isBlocked(source: string): boolean {
  const b = blocks.get(source);
  if (!b) return false;
  if (b.until <= Date.now()) {
    blocks.delete(source);
    return false;
  }
  return true;
}

export function blockedSources(): Array<{ source: string; until: string; reason: string }> {
  return [...blocks.entries()]
    .filter(([s]) => isBlocked(s))
    .map(([source, b]) => ({ source, until: new Date(b.until).toISOString(), reason: b.reason }));
}

export function clearSourceHealth(): void {
  blocks.clear();
}

/** The status of a failed request (axios), if any */
export const statusOf = (err: unknown): number | undefined => (err as { response?: { status?: number } })?.response?.status;
