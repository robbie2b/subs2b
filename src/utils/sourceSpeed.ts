import { keepAlive } from './background';
import { getProviderSpeeds, ProviderSpeed } from '../storage/usageStore';
import { Logger } from './logger';

/**
 * How fast each source usually answers (from the latest searches), for the dynamic timeout: a source the user ranks
 * higher than the one with the good subtitle is waited for only as long as it usually takes. Read in the background and
 * kept in memory; until it is known (a new server instance) the callers use a fixed fallback.
 */

const REFRESH_MS = 10 * 60 * 1000;
const known = new Map<string, { at: number; speeds: Map<string, ProviderSpeed> }>();
const loading = new Set<string>();

/** What is known now (maybe nothing), and a refresh in the background when it is old */
export function sourceSpeeds(configKey: string | undefined): Map<string, ProviderSpeed> | null {
  if (!configKey) return null;
  const entry = known.get(configKey);
  if ((!entry || Date.now() - entry.at > REFRESH_MS) && !loading.has(configKey)) {
    loading.add(configKey);
    keepAlive(getProviderSpeeds(configKey)
      .then(speeds => { known.set(configKey, { at: Date.now(), speeds }); })
      .catch(err => Logger.warn('Source speeds could not be read', { reason: err instanceof Error ? err.message : String(err) }))
      .finally(() => { loading.delete(configKey); }));
  }
  return entry ? entry.speeds : null;
}

/** For tests */
export function setSourceSpeeds(configKey: string, speeds: Map<string, ProviderSpeed>): void {
  known.set(configKey, { at: Date.now(), speeds });
}

export function clearSourceSpeeds(): void {
  known.clear();
}
