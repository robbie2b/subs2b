import { parentPort } from 'worker_threads';
import { alignAgainst, referencesAgree } from './alignDecision';

/**
 * Worker thread for the Subsync computation (see alignPool.ts). The computation takes seconds on a small server and
 * would otherwise stop the whole server (every other request waits) while it runs.
 */

export type AlignJob =
  | { id: number; op: 'align'; text: string; references: Parameters<typeof alignAgainst>[1] }
  | { id: number; op: 'agree'; references: Parameters<typeof referencesAgree>[0] };

parentPort?.on('message', (job: AlignJob) => {
  try {
    const value = job.op === 'align' ? alignAgainst(job.text, job.references) : referencesAgree(job.references);
    parentPort!.postMessage({ id: job.id, ok: true, value });
  } catch (err: unknown) {
    parentPort!.postMessage({ id: job.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
