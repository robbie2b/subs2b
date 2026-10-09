import { readCues } from '../utils/subtitleCues';
import { alignToReference, decide, AlignCache, Decision, RefAlignment, TimedCue } from '../utils/subsync';
import { parseRelease, variantsOf } from '../utils/scorer';

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
  references: Array<{ label: string; provider?: string; offset: number; score: number; ratio: number; segments: number }>;
  /** what else the Debug page should know (references left out...) */
  note?: string;
}

/** Release groups a name stands for (several when it lists several releases); a reference label is "[lang] name" */
export function groupsOf(name: string | undefined | null): Set<string> {
  const groups = new Set<string>();
  for (const v of variantsOf((name || '').replace(/^\[[^\]]*\]\s*/, ''))) {
    const g = parseRelease(v).group;
    if (g) groups.add(g.toLowerCase());
  }
  return groups;
}

const shareGroup = (a: Set<string>, b: Set<string>): boolean => [...a].some(g => b.has(g));

/** How many different releases the references of a list come from (a reference without a known group counts alone) */
function distinctReleases(list: RefAlignment[]): number {
  const seen = new Set<string>();
  let unknown = 0;
  for (const a of list) {
    const g = groupsOf(a.label);
    if (g.size === 0) unknown++;
    else seen.add([...g].sort().join('+'));
  }
  return seen.size + unknown;
}

const alignOne = (cues: TimedCue[], r: Reference, split: boolean, topRatios: number, cache: AlignCache): RefAlignment | null => {
  const result = alignToReference(cues, r.cues, { split, splitPenalty: 7, topRatios, cache });
  return result ? { label: r.label, provider: r.provider, result } : null;
};

const medianOf = (a: number[]): number => {
  const s = a.slice().sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/**
 * How well a reference made for the playing file's own release must fit to be followed alone. Lower than for any
 * single reference (0.85): its timeline is the file's, what differs is only the translation (lines split or merged).
 */
const FILE_REFERENCE_MIN_OVERLAP = 0.7;

/**
 * Aligns a subtitle against the references. First with one single shift per reference (fast); only when that is not
 * convincing, with shifts that may change along the subtitle (and the frame-rate ratio).
 * A reference made for the playing file's own release (its group in `fileName`) has the last word: it is tried
 * first, alone, and when the subtitle lines up with it the other references are not needed (Gone Baby Gone: an
 * EPSiLON reference said -7.9 s for an EPSiLON file, another release said -2.3 s, and nothing was done).
 */
export function alignAgainst(candidateText: string, allReferences: Reference[], candidateRelease?: string, fileName?: string): AlignmentResult {
  // A reference made for the subtitle's own release only repeats the subtitle's timing: it says nothing about the
  // playing file (Downton Abbey: a SHORTBREHD subtitle "confirmed" by SHORTBREHD references on a FraMeSToR REMUX)
  const own = groupsOf(candidateRelease);
  const references = own.size ? allReferences.filter(r => !shareGroup(groupsOf(r.label), own)) : allReferences;
  const leftOut = allReferences.length - references.length;
  const note = leftOut ? `${leftOut} reference(s) of the subtitle's own release (${[...own].join(', ')}) left out` : undefined;
  if (allReferences.length > 0 && references.length === 0) {
    return {
      decision: { apply: false, offset: 0, ratio: 1, segments: 0, confidence: 0, agreeing: 0, reason: 'no independent reference' },
      references: [],
      note
    };
  }
  const cues = readCues(candidateText);
  if (cues.length < MIN_REFERENCE_CUES || references.length === 0) {
    return {
      decision: { apply: false, offset: 0, ratio: 1, segments: 0, confidence: 0, agreeing: 0, reason: references.length === 0 ? 'no reference found' : 'the subtitle has too few cues' },
      references: [],
      ...(note ? { note } : {})
    };
  }

  // the spectra and correlations are shared by both passes and all references (freed when this decision is done)
  const cache = new AlignCache();
  type DecideOptions = Parameters<typeof decide>[2];
  // the references are taken one by one; once two of them agree (and fit well) the rest is not needed
  const collect = (refs: Reference[], split: boolean, topRatios: number, opts?: DecideOptions): { list: RefAlignment[]; decision: Decision } => {
    const list: RefAlignment[] = [];
    let d = decide(cues, list, opts);
    for (const r of refs) {
      const a = alignOne(cues, r, split, topRatios, cache);
      if (a) list.push(a);
      d = decide(cues, list, opts);
      // (two references of one release agreeing prove less: then the next one is looked at too)
      if (list.length >= 2 && d.agreeing >= 2 && d.confidence >= 0.9 && distinctReleases(list) >= 2) break;
    }
    return { list, decision: d };
  };
  const fits = (d: Decision) => d.apply || d.reason === 'already aligned';
  /** single shift first; the split search only when that is not convincing */
  const run = (refs: Reference[], opts?: DecideOptions): { list: RefAlignment[]; decision: Decision } => {
    const first = collect(refs, false, 1, opts);
    let best = first;
    // (when one shift already worked, the ratio is known: the split search tries only that one, which is much cheaper)
    if (!fits(first.decision) || (first.decision.apply && first.decision.confidence < 0.95)) {
      const second = collect(refs, true, first.decision.apply ? 1 : 2, opts);
      if (second.decision.apply && (!first.decision.apply || second.decision.confidence >= first.decision.confidence)) best = second;
    }
    return best;
  };
  const describe = (decision: Decision, used: RefAlignment[], extra?: string): AlignmentResult => ({
    decision,
    ...(note || extra ? { note: [extra, note].filter(Boolean).join('; ') } : {}),
    references: used.map(a => ({
      label: a.label,
      ...(a.provider ? { provider: a.provider } : {}),
      offset: Math.round(medianOf(a.result.offsets) * 10) / 10,
      score: Math.round(a.result.overlap * 100) / 100,
      ratio: Math.round(a.result.ratio * 1000) / 1000,
      segments: a.result.segments.length
    }))
  });

  // the playing file's own release first: it has the last word when the subtitle lines up with it
  const fileGroups = new Set([...groupsOf(fileName)].filter(g => !own.has(g)));
  const fileRefs = fileGroups.size ? references.filter(r => shareGroup(groupsOf(r.label), fileGroups)) : [];
  if (fileRefs.length) {
    const byFile = run(fileRefs, { singleMinOverlap: FILE_REFERENCE_MIN_OVERLAP });
    if (fits(byFile.decision)) {
      return describe(byFile.decision, byFile.list, `followed the reference(s) made for the file's own release (${[...fileGroups].join(', ')})`);
    }
  }

  const all = run(references);
  return describe(all.decision, all.list);
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
