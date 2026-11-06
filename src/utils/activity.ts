import { INSTANCE_ID } from './logger';

/**
 * What the server is doing, step by step, for the Live activity panel of the Debug page: a search starts, a source
 * answers, the list is ready, a subtitle is synced, it is sent... Kept in memory (the latest events only); on a host with
 * several instances (Vercel) each instance has its own, and the page tells them apart by `instance`.
 */

export type ActivityKind = 'request' | 'search' | 'source' | 'rank' | 'list' | 'sync' | 'send' | 'done' | 'warn';

/** The steps of one play, in order: what the Live activity panel draws as the checkpoints of a progress bar */
export type ActivityStep = 'request' | 'search' | 'rank' | 'list' | 'references' | 'compute' | 'asked' | 'delivered';

/** The same event in a form the panel can draw (the text stays for people and tests) */
export interface ActivityMeta {
  step?: ActivityStep;
  state?: 'start' | 'done' | 'warn';
  /** how long the step took (list: since the request; references: since the preparation started...) */
  ms?: number;
  /** search start: the sources being asked */
  sources?: string[];
  /** search done: the sources not waited for (dynamic timeout) */
  waived?: string[];
  /** one source answered (late = after the list was sent) */
  src?: { name: string; state: 'ok' | 'fail' | 'late'; ms: number; count?: number; error?: string };
  /** list: the first subtitle goes to the player as it is (no link through this server), so there is no "player asked" */
  direct?: boolean;
  /** compute done: what Subsync decided, short */
  verdict?: string;
}

export interface ActivityEvent {
  seq: number;
  at: string;
  kind: ActivityKind;
  /** what is being played: the file name when the player sent it, else the content id */
  film: string;
  text: string;
  meta?: ActivityMeta;
}

const MAX_EVENTS = 600;
const buffer: ActivityEvent[] = [];
let nextSeq = 1;

/** The name shown for a film: the file name, else the id (shortened) */
export function filmLabel(id: string, filename?: string | null): string {
  const name = filename && filename.trim() ? filename.trim() : id;
  return name.length > 90 ? `${name.slice(0, 89)}…` : name;
}

/** 1234 -> "1.2 s", 87 -> "87 ms" */
export function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} s` : `${Math.round(ms)} ms`;
}

let sink: ((event: ActivityEvent) => void) | null = null;

/** Every step is also handed to this (the database store), so all server instances can show it */
export function attachActivitySink(save: (event: ActivityEvent) => void): void {
  sink = save;
}

export function activity(kind: ActivityKind, film: string, text: string, meta?: ActivityMeta): void {
  const event: ActivityEvent = { seq: nextSeq++, at: new Date().toISOString(), kind, film, text, ...(meta ? { meta } : {}) };
  buffer.push(event);
  try { sink?.(event); } catch { /* the page must never break a search */ }
  if (buffer.length > MAX_EVENTS) buffer.shift();
}

/**
 * Events newer than `afterSeq` (0 = everything still kept). `afterSeq` only counts when `instance` is this process
 * (a number from another instance means nothing here: the whole buffer is sent and the page drops what it has seen).
 */
export function getActivity(afterSeq = 0, instance?: string): { events: ActivityEvent[]; last: number; instance: string } {
  const after = instance === undefined || instance === INSTANCE_ID ? afterSeq : 0;
  return { events: buffer.filter(e => e.seq > after), last: nextSeq - 1, instance: INSTANCE_ID };
}

export function clearActivity(): void {
  buffer.length = 0;
}
