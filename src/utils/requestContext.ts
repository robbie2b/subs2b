import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';

/**
 * Whose request is being served. Every request made under a configuration's address (`/<uuid>/...`) runs inside this
 * context, so everything the server records on the way (log lines, live activity, failed downloads, request counts)
 * can be tagged with the profile it belongs to, and the Debug page of one profile never shows another's. Work started
 * by the request (background tasks, searches, preparations) keeps the tag: the context follows the promises.
 */

const storage = new AsyncLocalStorage<{ owner: string }>();

/** A short, one-way name for a configuration (the address itself is never stored in what the Debug page reads) */
export const ownerOf = (configKey: string): string =>
  crypto.createHash('sha256').update(configKey.toLowerCase()).digest('hex').slice(0, 16);

/** The owner of the request being served, or undefined outside any profile (start-up, shared background work) */
export function currentOwner(): string | undefined {
  return storage.getStore()?.owner;
}

/** Runs `fn` as the given configuration */
export function runAsOwner<T>(configKey: string, fn: () => T): T {
  return storage.run({ owner: ownerOf(configKey) }, fn);
}

/** What a profile may see: its own records, and the ones that belong to no profile (the server itself) */
export const visibleTo = (recordOwner: string | undefined, viewer: string | undefined): boolean =>
  recordOwner === undefined || recordOwner === viewer;
