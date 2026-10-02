/**
 * The downloads that failed (a source refusing this server, a broken archive, a site down...), newest first. Kept in
 * memory and, through the store attached at start (storage/downloadFailureStore), in PostgreSQL, so Debug shows them
 * after a restart too. A failure that a backup source made up for is noted as "recovered".
 */

export interface DownloadFailure {
  at: string;
  /** the host that failed (or "every source" when nothing could be downloaded) */
  host: string;
  /** which download: proxy, opensubtitles, regielive, aligned, fallback */
  place: string;
  reason: string;
  /** a backup source was downloaded instead */
  recovered: boolean;
  release?: string;
}

const MAX_KEPT = 300;
const recent: DownloadFailure[] = [];
let saver: ((f: DownloadFailure) => void) | null = null;

export function noteDownloadFailure(f: Omit<DownloadFailure, 'at'> & { at?: string }): void {
  const entry: DownloadFailure = {
    at: f.at || new Date().toISOString(),
    host: f.host.slice(0, 200),
    place: f.place,
    reason: f.reason.slice(0, 500),
    recovered: f.recovered,
    ...(f.release ? { release: f.release.slice(0, 300) } : {})
  };
  recent.unshift(entry);
  if (recent.length > MAX_KEPT) recent.length = MAX_KEPT;
  saver?.(entry);
}

/** The failures read back from the database at start (older than the ones of this run) */
export function restoreDownloadFailures(list: DownloadFailure[]): void {
  const seen = new Set(recent.map(f => f.at + f.host + f.reason));
  for (const f of list) if (!seen.has(f.at + f.host + f.reason)) recent.push(f);
  recent.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  if (recent.length > MAX_KEPT) recent.length = MAX_KEPT;
}

export function attachDownloadFailureStore(save: (f: DownloadFailure) => void): void {
  saver = save;
}

/** The failures, newest first, and how many per host over the last 7 days */
export function downloadFailures(): { entries: DownloadFailure[]; lastWeek: Array<{ host: string; failed: number; recovered: number }> } {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const byHost = new Map<string, { failed: number; recovered: number }>();
  for (const f of recent) {
    if (f.at < since) continue;
    const h = byHost.get(f.host) || { failed: 0, recovered: 0 };
    if (f.recovered) h.recovered++; else h.failed++;
    byHost.set(f.host, h);
  }
  return {
    entries: recent.slice(),
    lastWeek: [...byHost.entries()].map(([host, n]) => ({ host, ...n })).sort((a, b) => b.failed + b.recovered - a.failed - a.recovered)
  };
}

export function clearDownloadFailures(): void {
  recent.length = 0;
}
