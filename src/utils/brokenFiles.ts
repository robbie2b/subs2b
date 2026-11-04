import { LRUCache } from 'lru-cache';

/**
 * Subtitle files that cannot be used: the site answers with an apology or an empty page instead of the archive
 * (Subtitrari-noi.ro: "Ne pare rău, subtitrarea nu este disponibilă momentan"), or the archive holds no readable
 * subtitle. Remembered for a few hours, so such a subtitle goes to the end of the list (see serverCanDownload) instead
 * of staying first and failing at every try. Kept in memory: a restart only means one more failed try.
 */

const KEEP_MS = 3 * 60 * 60 * 1000;
const broken = new LRUCache<string, string>({ max: 3000, ttl: KEEP_MS });

/**
 * Is this failure the file's own fault (and not a block of this server, which comes and goes)? A page of HTML or an
 * answer of JSON may be a block page: those are left alone. A file with no timing, or an empty one, is broken.
 */
export function isBrokenFileReason(reason: string | undefined): boolean {
  return /^No valid timing block|^Empty subtitle file/i.test(reason || '');
}

export function noteBrokenFile(url: string, reason: string): void {
  if (url) broken.set(url, reason);
}

export function isBrokenFile(url: string): boolean {
  return broken.has(url);
}

export function clearBrokenFiles(): void {
  broken.clear();
}
