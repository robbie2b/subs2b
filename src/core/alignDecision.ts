import { readCues } from '../utils/subtitleCues';
import { alignToReference, decide, AlignCache, Decision, RefAlignment, TimedCue } from '../utils/subsync';

/**
 * Deciding how to re-time one subtitle against the references. Pure computation (no network, no storage), so it can
 * run in a worker thread (see alignPool.ts) without loading the rest of the server.
 */

export const MIN_REFERENCE_CUES = 40;

export interface Reference {
  label: string;
  lang: string;
  provider: string;
  /** times and whether each cue is dialogue (the text itself is not kept) */
  cues: TimedCue[];
}

// ---------------------------------------------------------------------------
// Aligning one subtitle
// ---------------------------------------------------------------------------

export interface AlignmentResult {
  decision: Decision;
  references: Array<{ label: string; offset: number; score: number; ratio: number; segments: number }>;
}

const alignOne = (cues: TimedCue[], r: Reference, split: boolean, topRatios: number, cache: AlignCache): RefAlignment | null => {
  const result = alignToReference(cues, r.cues, { split, splitPenalty: 7, topRatios, cache });
  return result ? { label: r.label, result } : null;
};

const medianOf = (a: number[]): number => {
  const s = a.slice().sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/**
 * Aligns a subtitle against the references. First with one single shift per reference (fast); only when that is not
 * convincing, with shifts that may change along the subtitle (and the frame-rate ratio).
 */
export function alignAgainst(candidateText: string, references: Reference[]): AlignmentResult {
  const cues = readCues(candidateText);
  if (cues.length < MIN_REFERENCE_CUES || references.length === 0) {
    return {
      decision: { apply: false, offset: 0, ratio: 1, segments: 0, confidence: 0, agreeing: 0, reason: references.length === 0 ? 'no reference found' : 'the subtitle has too few cues' },
      references: []
    };
  }

  // the spectra and correlations are shared by both passes and all references (freed when this decision is done)
  const cache = new AlignCache();
  // the references are taken one by one; once two of them agree (and fit well) the rest is not needed
  const collect = (split: boolean, topRatios: number): { list: RefAlignment[]; decision: Decision } => {
    const list: RefAlignment[] = [];
    let d = decide(cues, list);
    for (const r of references) {
      const a = alignOne(cues, r, split, topRatios, cache);
      if (a) list.push(a);
      d = decide(cues, list);
      if (list.length >= 2 && d.agreeing >= 2 && d.confidence >= 0.9) break;
    }
    return { list, decision: d };
  };

  const first = collect(false, 1);
  let used = first.list;
  let decision = first.decision;

  // (when one shift already worked, the ratio is known: the split search tries only that one, which is much cheaper)
  if ((!decision.apply && decision.reason !== 'already aligned') || (decision.apply && decision.confidence < 0.95)) {
    const second = collect(true, decision.apply ? 1 : 2);
    if (second.decision.apply && (!decision.apply || second.decision.confidence >= decision.confidence)) {
      decision = second.decision;
      used = second.list;
    }
  }

  return {
    decision,
    references: used.map(a => ({
      label: a.label,
      offset: Math.round(medianOf(a.result.offsets) * 10) / 10,
      score: Math.round(a.result.overlap * 100) / 100,
      ratio: Math.round(a.result.ratio * 1000) / 1000,
      segments: a.result.segments.length
    }))
  };
}

/** The subtitle can be served: it lines up with the references (as it is, or once shifted) */
export function fitsReferences(result: AlignmentResult): boolean {
  return result.decision.apply || result.decision.reason === 'already aligned';
}

/**
 * Do (at least) two references share one timeline? Only then is a subtitle that fits none of them clearly made for
 * another release, and worth replacing with an alternative.
 */
export function referencesAgree(references: Reference[]): boolean {
  for (let i = 0; i < references.length; i++) {
    for (let j = i + 1; j < references.length; j++) {
      const r = alignToReference(references[j].cues, references[i].cues, { split: false, topRatios: 1 });
      if (r && r.overlap >= 0.7 && Math.abs(r.ratio - 1) < 0.0005 && Math.abs(medianOf(r.offsets)) <= 0.5) return true;
    }
  }
  return false;
}
