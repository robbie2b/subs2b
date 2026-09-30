/**
 * Subtitle timelines: reading cue times and finding the constant shift between two subtitles of the same video.
 * Only WHEN lines appear is compared (never the text), so the two subtitles may be in different languages.
 */

export interface Cue {
  start: number;
  end: number;
}

const TIMING = /(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/g;

/** Cue start/end times (seconds) of an SRT or WebVTT text */
export function parseCues(text: string): Cue[] {
  const cues: Cue[] = [];
  const ms = (v: string): number => parseInt(v.padEnd(3, '0'), 10) / 1000;
  const seconds = (h: string | undefined, m: string, s: string, f: string): number =>
    (h ? parseInt(h, 10) * 3600 : 0) + parseInt(m, 10) * 60 + parseInt(s, 10) + ms(f);

  TIMING.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TIMING.exec(text)) !== null) {
    const start = seconds(match[1], match[2], match[3], match[4]);
    const end = seconds(match[5], match[6], match[7], match[8]);
    if (end > start) cues.push({ start, end });
  }
  return cues;
}

/** 1 where a cue is on screen, sampled every `res` seconds */
function activity(cues: Cue[], res: number, length: number): Uint8Array {
  const v = new Uint8Array(length);
  for (const c of cues) {
    const a = Math.max(0, Math.floor(c.start / res));
    const b = Math.min(length - 1, Math.ceil(c.end / res));
    for (let i = a; i <= b; i++) v[i] = 1;
  }
  return v;
}

/** Overlap (F1, 0..1) between `a` shifted by `shift` samples and `b` */
function overlap(a: Uint8Array, b: Uint8Array, shift: number, totalA: number, totalB: number): number {
  let inter = 0;
  for (let i = 0; i < a.length; i++) {
    if (!a[i]) continue;
    const j = i + shift;
    if (j >= 0 && j < b.length && b[j]) inter++;
  }
  const denom = totalA + totalB;
  return denom ? (2 * inter) / denom : 0;
}

const count = (v: Uint8Array): number => {
  let n = 0;
  for (let i = 0; i < v.length; i++) if (v[i]) n++;
  return n;
};

export interface TimelineFit {
  /** seconds to ADD to the candidate's times so that it lines up with the reference */
  offset: number;
  /** overlap of the two timelines after the shift, 0..1 */
  score: number;
}

/**
 * Finds the constant shift that best lines `candidate` up with `reference` (search within +-maxShift seconds:
 * 1 s steps first, then 0.1 s around the best one).
 */
export function fitOffset(candidate: Cue[], reference: Cue[], maxShift = 60): TimelineFit {
  if (candidate.length === 0 || reference.length === 0) return { offset: 0, score: 0 };

  const end = Math.max(...candidate.map(c => c.end), ...reference.map(c => c.end)) + maxShift + 5;

  // coarse: 1 s samples
  const cLen = Math.ceil(end) + 2;
  const a1 = activity(candidate, 1, cLen);
  const b1 = activity(reference, 1, cLen);
  const ta1 = count(a1);
  const tb1 = count(b1);
  let best = { shift: 0, score: -1 };
  for (let shift = -maxShift; shift <= maxShift; shift++) {
    const s = overlap(a1, b1, shift, ta1, tb1);
    if (s > best.score) best = { shift, score: s };
  }

  // fine: 0.1 s samples, +-2 s around the coarse optimum
  const fLen = Math.ceil(end * 10) + 20;
  const a2 = activity(candidate, 0.1, fLen);
  const b2 = activity(reference, 0.1, fLen);
  const ta2 = count(a2);
  const tb2 = count(b2);
  let fine = { shift: best.shift * 10, score: -1 };
  for (let shift = best.shift * 10 - 20; shift <= best.shift * 10 + 20; shift++) {
    const s = overlap(a2, b2, shift, ta2, tb2);
    if (s > fine.score) fine = { shift, score: s };
  }

  // candidate time t matches reference time t + shift/10, so ADD shift/10 seconds to the candidate
  return { offset: Math.round(fine.shift) / 10, score: Math.round(fine.score * 1000) / 1000 };
}

export interface ReferenceVote {
  /** shift measured against one reference */
  offset: number;
  score: number;
}

export interface AlignmentDecision {
  apply: boolean;
  offset: number;
  confidence: number;
  reason: string;
}

/**
 * Decides whether and how much to shift, from the fits against one or more references:
 * - each fit must overlap well (>= minScore);
 * - with two or more usable references they must agree (within `agree` seconds); with one, it must be very good;
 * - a shift below `noise` seconds is not worth applying.
 */
export function decideAlignment(
  votes: ReferenceVote[],
  opts: { minScore?: number; singleMinScore?: number; agree?: number; noise?: number; maxOffset?: number } = {}
): AlignmentDecision {
  const minScore = opts.minScore ?? 0.8;
  const singleMinScore = opts.singleMinScore ?? 0.9;
  const agree = opts.agree ?? 0.5;
  const noise = opts.noise ?? 0.3;
  const maxOffset = opts.maxOffset ?? 60;

  const usable = votes.filter(v => v.score >= minScore && Math.abs(v.offset) <= maxOffset);
  if (usable.length === 0) return { apply: false, offset: 0, confidence: 0, reason: 'no reference fits well enough' };

  // the largest group of references that agree with each other
  let group: ReferenceVote[] = [];
  for (const anchor of usable) {
    const members = usable.filter(v => Math.abs(v.offset - anchor.offset) <= agree);
    if (members.length > group.length) group = members;
  }

  if (group.length === 1 && usable.length > 1) {
    return { apply: false, offset: 0, confidence: 0, reason: 'the references disagree with each other' };
  }
  if (group.length === 1 && group[0].score < singleMinScore) {
    return { apply: false, offset: 0, confidence: group[0].score, reason: 'a single reference that is not convincing enough' };
  }

  const offset = Math.round((group.reduce((s, v) => s + v.offset, 0) / group.length) * 10) / 10;
  const confidence = Math.round((group.reduce((s, v) => s + v.score, 0) / group.length) * 100) / 100;
  if (Math.abs(offset) < noise) {
    return { apply: false, offset: 0, confidence, reason: 'already aligned' };
  }
  return { apply: true, offset, confidence, reason: `${group.length} reference(s) agree` };
}
