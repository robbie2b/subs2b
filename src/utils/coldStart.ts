import { INSTANCE_ID } from './logger';

/**
 * Cold-start measurement. Every serverless instance starts empty (nothing in memory, no database connection, no source
 * statistics). The first list an instance answers is marked `cold`, and every list carries the age of its instance and its
 * running number, so the Debug data can show how much slower the first request after a pause is than a warm one.
 */
let served = 0;

export interface InstanceInfo {
  /** the instance (the same name the log lines carry) */
  id: string;
  /** seconds since this instance's process started */
  ageSec: number;
  /** how many lists this instance had answered before this one, plus one (1 = the first request: cold) */
  seq: number;
}

export function noteRequest(): InstanceInfo {
  served++;
  return { id: INSTANCE_ID, ageSec: Math.round(process.uptime() * 10) / 10, seq: served };
}

/** (for the tests) */
export function resetColdStart(): void { served = 0; }
