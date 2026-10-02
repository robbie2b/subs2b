import path from 'path';
import { Worker } from 'worker_threads';
import { Logger } from '../utils/logger';
import { alignAgainst, referencesAgree, AlignmentResult, Reference } from './alignDecision';
import type { AlignJob } from './alignWorker';

/**
 * Runs the Subsync computation on one worker thread, one job at a time (the server has a fraction of one CPU, so
 * parallel jobs would only slow each other down). The server keeps answering other requests meanwhile.
 * When the worker cannot be started (or SUBSYNC_WORKER=0), the computation runs on the main thread, as before.
 */

/** The worker died (not the computation): the job is run again on the main thread */
class WorkerCrash extends Error {}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

let worker: Worker | null = null;
let workerBroken = false;
let nextId = 1;
const pending = new Map<number, Pending>();

function failAll(err: Error): void {
  for (const p of pending.values()) p.reject(err);
  pending.clear();
}

function getWorker(): Worker | null {
  if (process.env.SUBSYNC_WORKER === '0' || workerBroken) return null;
  if (worker) return worker;
  try {
    // the same extension as this file: .js once built, .ts when run from source (tests, through tsx)
    const ext = path.extname(__filename);
    const file = path.join(__dirname, `alignWorker${ext}`);
    const w = ext === '.ts'
      ? new Worker(`require('tsx/cjs'); require(${JSON.stringify(file)});`, { eval: true, execArgv: [] })
      : new Worker(file);
    w.unref();
    w.on('message', (msg: { id: number; ok: boolean; value?: unknown; error?: string }) => {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value); else p.reject(new Error(msg.error || 'subsync worker error'));
    });
    w.on('error', (err: Error) => {
      // the worker itself is broken (not one computation): from now on the computation runs on the main thread
      Logger.warn('Subsync worker failed, computing on the main thread from now on', { reason: err.message });
      workerBroken = true;
      if (worker === w) worker = null;
      failAll(new WorkerCrash(err.message));
    });
    w.on('exit', code => {
      if (worker === w) worker = null;
      if (pending.size) failAll(new WorkerCrash(`subsync worker stopped (code ${code})`));
    });
    worker = w;
    return w;
  } catch (err: unknown) {
    workerBroken = true;
    Logger.warn('Subsync worker could not be started, computing on the main thread', { reason: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

function run<T>(job: Omit<AlignJob, 'id'>, inline: () => T): Promise<T> {
  const w = getWorker();
  if (!w) {
    try { return Promise.resolve(inline()); } catch (err) { return Promise.reject(err); }
  }
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    // a waiting job keeps the process alive; an idle worker does not
    if (pending.size === 1) w.ref();
    w.postMessage({ ...job, id });
  })
    .catch(err => { if (err instanceof WorkerCrash) return inline(); throw err; })
    .finally(() => { if (pending.size === 0) worker?.unref(); });
}

export function alignInWorker(text: string, references: Reference[], release?: string, file?: string): Promise<AlignmentResult> {
  return run({ op: 'align', text, references, release, file } as Omit<AlignJob, 'id'>, () => alignAgainst(text, references, release, file));
}

export function referencesAgreeInWorker(references: Reference[]): Promise<boolean> {
  return run({ op: 'agree', references } as Omit<AlignJob, 'id'>, () => referencesAgree(references));
}

/** Starts the worker ahead of time (at server start), so the first alignment does not wait for it to load */
export function warmUpAlignWorker(): void {
  getWorker();
}

/** Stops the worker (tests) */
export async function stopAlignWorker(): Promise<void> {
  const w = worker;
  worker = null;
  if (w) await w.terminate();
}
