/**
 * Small in-memory log of the latest subtitle requests, per addon configuration.
 * Lets the owner (or Claude) see what was requested and how subtitles were scored,
 * without copying Render logs. Nothing is written to disk; it resets when the server restarts.
 */

export interface DebugTopEntry {
  rank: number;
  score: number;
  rejected: boolean;
  provider: string;
  release: string;
  reasons: string[];
}

export interface DebugEntry {
  at: string;
  id: string;
  extra: Record<string, string | undefined> | undefined;
  rawTotal: number;
  rawByProvider: Record<string, number>;
  afterLanguage: number;
  afterDedup: number;
  /** subtitles removed as duplicates of a similar release */
  dedupDropped: Array<{ provider: string; release: string }>;
  afterScoring: number;
  /** how many subtitles were actually sent to the player (after the Results limit) */
  shown?: number;
  usedFilename: boolean;
  scoringFallback: boolean;
  top: DebugTopEntry[];
}

const MAX_ENTRIES = 40;
const store = new Map<string, DebugEntry[]>();

export function recordDebug(key: string, entry: DebugEntry): void {
  const list = store.get(key) || [];
  list.unshift(entry);
  if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES;
  store.set(key, list);
}

export function getDebug(key: string): DebugEntry[] {
  return store.get(key) || [];
}
