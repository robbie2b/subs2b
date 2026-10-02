import { retimeSubtitle } from './subtitleCues';

/** A cue with its times (seconds); `speech` (dialogue or not) is worked out from `text` when it is not given */
export interface TimedCue {
  start: number;
  end: number;
  text?: string;
  speech?: boolean;
}

/**
 * Subtitle-to-subtitle alignment, after the ideas of ffsubsync (MIT) and alass:
 *
 *  1. every subtitle becomes a "speech signal" (1 while a dialogue cue is on screen, 0 otherwise);
 *  2. the subtitle may be stretched by a frame-rate ratio (24/23.976, 25/23.976, 25/24, their inverses and the ratio of
 *     the two lengths); for each ratio the best constant shift is found by cross-correlation (FFT);
 *  3. for the best ratios, a dynamic program lets the shift change from cue to cue, paying a "split penalty" for every
 *     change, so a subtitle whose shift changes in the middle (a cut, a different edit) can be followed;
 *  4. the shifts are refined to 10 ms.
 *
 * Only WHEN lines appear is used (never the text), so the two subtitles may be in different languages.
 */

export interface SpeechCue {
  start: number;
  end: number;
}

/** Frame-rate ratios that are tried besides 1 (the ones ffsubsync uses) */
const BASE_RATIOS = [24 / 23.976, 25 / 23.976, 25 / 24];
export const FRAMERATE_RATIOS: number[] = [...BASE_RATIOS, ...BASE_RATIOS.map(r => 1 / r)];

const NON_DIALOGUE = new Set(['♪', '♫', '♬', '♩', '#', '*', '~', '-', '–', '—', '.', '…']);
const PAIRS: Record<string, string> = { '[': ']', '(': ')', '{': '}', '<': '>', '♪': '♪', '#': '#' };

/** Cues that are not dialogue (sound descriptions, music, credits at the edges) say nothing about speech timing */
export function isNonDialogue(text: string, atEdge: boolean): boolean {
  const c = text.replace(/<[^>]*>|\{[^}]*\}/g, '').trim();
  if (!c) return true;
  const closing = PAIRS[c[0]];
  if (closing && c[c.length - 1] === closing) return true;
  if ([...c].every(ch => /\s/.test(ch) || NON_DIALOGUE.has(ch))) return true;
  if (atEdge && (/english/i.test(c) || c.includes(' - '))) return true;
  return false;
}

/** Dialogue cues of a subtitle (the rest are returned with `speech: false`) */
export function speechFlags(cues: TimedCue[]): boolean[] {
  return cues.map((c, i) => c.speech ?? !isNonDialogue(c.text ?? '', i === 0 || i === cues.length - 1));
}

// ---------------------------------------------------------------------------
// FFT
// ---------------------------------------------------------------------------
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inverse ? -1 : 1);
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

const nextPow2 = (n: number): number => { let p = 1; while (p < n) p <<= 1; return p; };

// ---------------------------------------------------------------------------
// Speech signals
// ---------------------------------------------------------------------------
export interface Interval { start: number; end: number }

function intervalsOf(cues: TimedCue[], flags: boolean[], ratio = 1): Interval[] {
  const out: Interval[] = [];
  cues.forEach((c, i) => { if (flags[i]) out.push({ start: c.start * ratio, end: c.end * ratio }); });
  return out;
}

/** How far a line must be from the rest to stand alone at an edge, and how many lines such a stray group may have */
const LONE_GAP = 120;
const LONE_MAX_LINES = 3;

/** The intervals without the few lines standing alone at the start or the end (see LONE_GAP) */
export function withoutLoneEdges(iv: Interval[]): Interval[] {
  const s = iv.slice().sort((a, b) => a.start - b.start);
  if (s.length <= 2 * LONE_MAX_LINES + 10) return s;
  let from = 0, to = s.length;
  for (let k = 1; k <= LONE_MAX_LINES; k++) {
    if (s[k].start - s[k - 1].end > LONE_GAP) from = k;
  }
  for (let k = 1; k <= LONE_MAX_LINES; k++) {
    if (s[s.length - k].start - s[s.length - k - 1].end > LONE_GAP) to = s.length - k;
  }
  return s.slice(from, to);
}

/** Share of every `dt`-second bin that is covered by speech (0..1) */
function coverage(intervals: Interval[], dt: number, length: number): Float64Array {
  const v = new Float64Array(length);
  for (const it of intervals) {
    const a = Math.max(0, Math.floor(it.start / dt));
    const b = Math.min(length - 1, Math.floor((it.end - 1e-9) / dt));
    for (let k = a; k <= b; k++) {
      const lo = Math.max(it.start, k * dt);
      const hi = Math.min(it.end, (k + 1) * dt);
      if (hi > lo) v[k] += (hi - lo) / dt;
    }
  }
  for (let k = 0; k < length; k++) if (v[k] > 1) v[k] = 1;
  return v;
}

/** Prefix integral of a reference's speech, sampled every 10 ms: P(t) = seconds of speech before t */
class SpeechIntegral {
  private readonly step = 0.01;
  private readonly cum: Float64Array;
  constructor(intervals: Interval[], horizon: number) {
    const n = Math.ceil(horizon / this.step) + 2;
    const cov = coverage(intervals, this.step, n);
    this.cum = new Float64Array(n + 1);
    for (let k = 0; k < n; k++) this.cum[k + 1] = this.cum[k] + cov[k] * this.step;
  }
  at(t: number): number {
    if (t <= 0) return 0;
    const pos = t / this.step;
    const lo = Math.floor(pos);
    if (lo >= this.cum.length - 1) return this.cum[this.cum.length - 1];
    const f = pos - lo;
    return this.cum[lo] * (1 - f) + this.cum[lo + 1] * f;
  }
}

const MAX_GUARD = 2; // seconds

/** Rating of one cue placed at `offset`: speech it overlaps minus a part of the speech right outside its edges */
function rating(P: SpeechIntegral, start: number, end: number, offset: number, lengthPenalty: number): number {
  const s = start + offset, e = end + offset;
  const ps = P.at(s), pe = P.at(e);
  let r = pe - ps;
  if (lengthPenalty > 0) {
    const g = Math.min(e - s, MAX_GUARD);
    r -= lengthPenalty * ((ps - P.at(s - g)) + (P.at(e + g) - pe));
  }
  return r;
}

// ---------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------
export interface Segment {
  fromCue: number;
  toCue: number;
  offset: number;
}

export interface AlignResult {
  /** the subtitle's times are multiplied by this first (frame-rate ratio) */
  ratio: number;
  /** seconds added to each cue (index = position in the subtitle) after the stretch */
  offsets: number[];
  segments: Segment[];
  /** overlap of the aligned dialogue with the reference's dialogue: share of the subtitle's speech time, 0..1 */
  overlap: number;
  /** correlation score of the single-shift search for the winning ratio */
  globalScore: number;
}

export interface AlignOptions {
  maxOffset?: number;      // seconds, default 60
  splitPenalty?: number;   // seconds of overlap, default 5 (large = one single shift)
  lengthPenalty?: number;  // default 0.25
  split?: boolean;         // default true
  topRatios?: number;      // how many ratios the split search is run for, default 3
  splitRange?: number;     // the split search looks this many seconds around the single shift, default 20
  exhaustive?: boolean;    // try every frame-rate ratio even when ratio 1 already fits (default false)
  cache?: AlignCache;      // shared work between alignments of the same subtitle (same results, less time)
}

const COARSE = 0.1; // seconds per sample of the coarse search

interface RatioScore { ratio: number; lag: number; score: number }

interface Spectrum { re: Float64Array; im: Float64Array }

/**
 * Work shared by the alignments of one subtitle: it is aligned against several references, twice (single shift,
 * then split), so the same spectra and correlations come back again and again. They are kept per cue array (the
 * arrays are not changed after reading). The cache is meant to live for one decision only: the spectra are big.
 */
export class AlignCache {
  readonly referenceSpectra = new WeakMap<TimedCue[], Map<string, Spectrum>>();
  readonly candidateSpectra = new WeakMap<TimedCue[], Map<string, Spectrum>>();
  readonly integrals = new WeakMap<TimedCue[], Map<number, SpeechIntegral>>();
  readonly ratioScores = new WeakMap<TimedCue[], WeakMap<TimedCue[], Map<string, RatioScore>>>();
}

function memo<K extends object, IK, V>(map: WeakMap<K, Map<IK, V>>, owner: K, key: IK, make: () => V): V {
  let inner = map.get(owner);
  if (!inner) { inner = new Map(); map.set(owner, inner); }
  let v = inner.get(key);
  if (v === undefined) { v = make(); inner.set(key, v); }
  return v;
}

export function alignToReference(candidate: TimedCue[], reference: TimedCue[], options: AlignOptions = {}): AlignResult | null {
  const maxOffset = options.maxOffset ?? 60;
  const splitPenalty = options.splitPenalty ?? 5;
  const lengthPenalty = options.lengthPenalty ?? 0.25;
  const topRatios = options.topRatios ?? 3;

  const cFlags = speechFlags(candidate);
  const rFlags = speechFlags(reference);
  const cIv = intervalsOf(candidate, cFlags);
  const rIv = intervalsOf(reference, rFlags);
  if (cIv.length < 10 || rIv.length < 10) return null;

  const span = (iv: Interval[]) => Math.max(...iv.map(i => i.end)) - Math.min(...iv.map(i => i.start));
  // The lengths are guessed twice: as they are, and without the lines standing alone at either end (up to 3 lines
  // more than 2 minutes away from the rest: a translator's note, a credit, an advert, in any language). Both guesses
  // add ratios to try; none is taken away (and every line is still aligned and moved).
  const guesses = [span(rIv) / span(cIv), span(withoutLoneEdges(rIv)) / span(withoutLoneEdges(cIv))];

  // Ratio 1, plus the usual frame-rate ratios that are close to what the lengths suggest, plus those ratios themselves
  // (the lengths differ a little for other reasons too, hence the generous 0.05). The ratios next to 1 (24 / 23.976)
  // are always tried: one line far from the dialogue is enough to mislead the lengths (Gone Baby Gone: a TiMELORDS
  // subtitle needing x0.999 was shifted at ratio 1, 3 s off at both ends)
  const plausible = (g: number) => g > 0.9 && g < 1.1;
  const anyGuess = guesses.some(plausible);
  const ratios = [1, ...FRAMERATE_RATIOS.filter(r => !anyGuess || Math.abs(r - 1) < 0.002
    || guesses.some(g => plausible(g) && Math.abs(r - g) <= 0.05))];
  for (const g of guesses) if (plausible(g) && !ratios.some(r => Math.abs(r - g) < 0.0005)) ratios.push(g);

  // ---- coarse search: one FFT cross-correlation per ratio ----
  const refEnd = Math.max(...rIv.map(i => i.end));
  const candEnd = Math.max(...cIv.map(i => i.end)) * Math.max(...ratios);
  const lr = Math.ceil(refEnd / COARSE) + 2;
  const lsMax = Math.ceil(candEnd / COARSE) + 2;
  const maxLag = Math.round(maxOffset / COARSE);
  // Only shifts up to maxLag are read, so the circular correlation needs room for the longer signal plus maxLag
  // (the other shifts may wrap around, they are never looked at)
  const N = nextPow2(Math.max(lr, lsMax) + maxLag + 2);

  const cache = options.cache ?? new AlignCache();
  const ref = memo(cache.referenceSpectra, reference, `${N}|${lr}`, () => {
    const refCov = coverage(rIv, COARSE, lr);
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let k = 0; k < lr; k++) re[k] = 2 * refCov[k] - 1;
    fft(re, im, false);
    return { re, im };
  });
  const br = ref.re, bi = ref.im;

  const P = memo(cache.integrals, reference, maxOffset, () => new SpeechIntegral(rIv, refEnd + maxOffset + 10));

  let pairScores = cache.ratioScores.get(candidate);
  if (!pairScores) { pairScores = new WeakMap(); cache.ratioScores.set(candidate, pairScores); }
  const scoresOf = pairScores;

  const scoreRatio = (ratio: number): RatioScore => memo(scoresOf, reference, `${ratio}|${N}|${maxLag}`, () => {
    const cand = memo(cache.candidateSpectra, candidate, `${ratio}|${N}`, () => {
      const ivs = intervalsOf(candidate, cFlags, ratio);
      const ls = Math.ceil(Math.max(...ivs.map(i => i.end)) / COARSE) + 2;
      const cov = coverage(ivs, COARSE, ls);
      const amp = Math.min(1 / ratio, 1);
      const re = new Float64Array(N), im = new Float64Array(N);
      for (let k = 0; k < ls; k++) re[k] = 2 * cov[k] * amp - 1;
      fft(re, im, false);
      return { re, im };
    });
    // conj(A) * B
    const ar = new Float64Array(N), ai = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      ar[k] = cand.re[k] * br[k] + cand.im[k] * bi[k];
      ai[k] = cand.re[k] * bi[k] - cand.im[k] * br[k];
    }
    fft(ar, ai, true);
    let bestLag = 0, bestScore = -Infinity;
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      const v = ar[lag >= 0 ? lag : N + lag];
      if (v > bestScore) { bestScore = v; bestLag = lag; }
    }
    return { ratio, lag: bestLag, score: bestScore };
  });

  // Ratio 1 first: when it already puts nearly all the dialogue on the reference's dialogue, the other ratios are skipped
  const first = scoreRatio(1);
  let quickOverlap = 0, quickTotal = 0;
  candidate.forEach((c, i) => {
    if (!cFlags[i]) return;
    quickOverlap += P.at(c.end + first.lag * COARSE) - P.at(c.start + first.lag * COARSE);
    quickTotal += c.end - c.start;
  });
  const scores: RatioScore[] = [first];
  if (options.exhaustive || quickTotal === 0 || quickOverlap / quickTotal < 0.9) {
    for (const ratio of ratios.slice(1)) scores.push(scoreRatio(ratio));
  }
  scores.sort((a, b) => b.score - a.score);

  // ---- fine search / split search, per ratio ----
  const R = Math.min(maxLag, Math.round((options.splitRange ?? 20) / COARSE));
  const nOff = 2 * R + 1;
  let best: AlignResult | null = null;
  let bestObjective = -Infinity;

  const candidates = options.split === false ? scores.slice(0, 1) : scores.slice(0, topRatios);
  for (const sc of candidates) {
    const cues = candidate.map(c => ({ start: c.start * sc.ratio, end: c.end * sc.ratio }));
    const nC = cues.length;

    let offsets: number[];
    let objective: number;

    if (options.split === false) {
      offsets = new Array(nC).fill(sc.lag * COARSE);
      objective = 0;
    } else {
      // dynamic program over the cues: the shift may change, at a price
      const dp = new Float64Array(nOff);
      const next = new Float64Array(nOff);
      const back = new Int16Array(nC * nOff).fill(-1);
      const row = new Float64Array(nOff);
      const fillRow = (i: number) => {
        if (!cFlags[i]) { row.fill(0); return; }
        for (let j = 0; j < nOff; j++) row[j] = rating(P, cues[i].start, cues[i].end, (sc.lag + j - R) * COARSE, lengthPenalty);
      };
      fillRow(0);
      dp.set(row);
      for (let i = 1; i < nC; i++) {
        let bestIdx = 0;
        for (let j = 1; j < nOff; j++) if (dp[j] > dp[bestIdx]) bestIdx = j;
        const jump = dp[bestIdx] - splitPenalty;
        fillRow(i);
        for (let j = 0; j < nOff; j++) {
          if (jump > dp[j]) { next[j] = row[j] + jump; back[i * nOff + j] = bestIdx; }
          else next[j] = row[j] + dp[j];
        }
        dp.set(next);
      }
      let cur = 0;
      for (let j = 1; j < nOff; j++) if (dp[j] > dp[cur]) cur = j;
      objective = dp[cur];
      const idx = new Array<number>(nC);
      for (let i = nC - 1; i >= 0; i--) {
        idx[i] = cur;
        if (i > 0) { const b = back[i * nOff + cur]; if (b >= 0) cur = b; }
      }
      offsets = idx.map(j => (sc.lag + j - R) * COARSE);
    }

    // refine every constant stretch to 10 ms
    const segments: Segment[] = [];
    let from = 0;
    for (let i = 1; i <= nC; i++) {
      if (i === nC || offsets[i] !== offsets[from]) {
        segments.push({ fromCue: from, toCue: i - 1, offset: offsets[from] });
        from = i;
      }
    }
    for (const seg of segments) {
      let bestO = seg.offset, bestR = -Infinity;
      for (let d = -0.1; d <= 0.1001; d += 0.01) {
        let total = 0;
        for (let i = seg.fromCue; i <= seg.toCue; i++) if (cFlags[i]) total += rating(P, cues[i].start, cues[i].end, seg.offset + d, lengthPenalty);
        if (total > bestR) { bestR = total; bestO = seg.offset + d; }
      }
      seg.offset = Math.round(bestO * 100) / 100;
      for (let i = seg.fromCue; i <= seg.toCue; i++) offsets[i] = seg.offset;
    }
    // neighbouring stretches that refined to the same value are one
    const merged: Segment[] = [];
    for (const seg of segments) {
      const last = merged[merged.length - 1];
      if (last && last.offset === seg.offset) last.toCue = seg.toCue; else merged.push({ ...seg });
    }

    let overlapSum = 0, speechSum = 0;
    cues.forEach((c, i) => {
      if (!cFlags[i]) return;
      overlapSum += P.at(c.end + offsets[i]) - P.at(c.start + offsets[i]);
      speechSum += c.end - c.start;
    });
    const overlap = speechSum > 0 ? overlapSum / speechSum : 0;

    // compare ratios by the split objective, or by the correlation score when splitting is off
    const value = options.split === false ? sc.score : objective;
    if (value > bestObjective) {
      bestObjective = value;
      best = { ratio: sc.ratio, offsets, segments: merged, overlap, globalScore: sc.score };
    }
  }
  return best;
}

/** The subtitle text, retimed according to an alignment */
export function applyAlignment(text: string, result: AlignResult): string {
  return retimeSubtitle(text, (i, s, e) => {
    const off = result.offsets[i] ?? result.offsets[result.offsets.length - 1] ?? 0;
    return [s * result.ratio + off, e * result.ratio + off];
  });
}

// ---------------------------------------------------------------------------
// Deciding from several references
// ---------------------------------------------------------------------------
export interface RefAlignment {
  label: string;
  result: AlignResult;
}

export interface Decision {
  apply: boolean;
  /** the alignment to apply (when `apply`) */
  result?: AlignResult;
  /** median shift of the chosen alignment, seconds (display only) */
  offset: number;
  ratio: number;
  segments: number;
  confidence: number;
  /** how many references agreed on the chosen alignment */
  agreeing: number;
  reason: string;
}

const median = (a: number[]): number => {
  const s = a.slice().sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/** Where each cue of the candidate starts after an alignment */
export function alignedStarts(candidate: TimedCue[], r: AlignResult): number[] {
  return candidate.map((c, i) => c.start * r.ratio + (r.offsets[i] ?? 0));
}

/**
 * Decides whether and how to retime a subtitle, from its alignment against one or more references:
 * - an alignment must be plausible (ratio within 10 %, shifts within 60 s, at most 8 pieces, most of the dialogue
 *   falling on the reference's dialogue);
 * - two or more references must AGREE (the cues start in the same places, within 0.5 s, for 80 % of the dialogue);
 *   a single reference must overlap very well;
 * - an alignment that changes nothing is reported as "already aligned".
 */
export function decide(
  candidate: TimedCue[],
  alignments: RefAlignment[],
  opts: { minOverlap?: number; singleMinOverlap?: number; agreeTolerance?: number; agreeShare?: number } = {}
): Decision {
  const minOverlap = opts.minOverlap ?? 0.6;
  const singleMin = opts.singleMinOverlap ?? 0.85;
  const tol = opts.agreeTolerance ?? 0.5;
  const share = opts.agreeShare ?? 0.8;
  const no = (reason: string, confidence = 0): Decision => ({ apply: false, offset: 0, ratio: 1, segments: 0, confidence, agreeing: 0, reason });

  if (alignments.length === 0) return no('no reference found');
  const flags = speechFlags(candidate);

  const usable = alignments.filter(a => {
    const r = a.result;
    return r.overlap >= minOverlap && r.ratio > 0.9 && r.ratio < 1.1 && r.segments.length <= 8
      && r.offsets.every(o => Math.abs(o) <= 60);
  });
  if (usable.length === 0) return no('no reference fits well enough');

  const starts = usable.map(a => alignedStarts(candidate, a.result));
  const agree = (i: number, j: number): number => {
    let n = 0, ok = 0;
    for (let k = 0; k < candidate.length; k++) {
      if (!flags[k]) continue;
      n++;
      if (Math.abs(starts[i][k] - starts[j][k]) <= tol) ok++;
    }
    return n ? ok / n : 0;
  };

  let group: number[] = [];
  for (let i = 0; i < usable.length; i++) {
    const members = usable.map((_, j) => j).filter(j => j === i || agree(i, j) >= share);
    const better = members.length > group.length
      || (members.length === group.length && members.length > 0
        && members.reduce((s, j) => s + usable[j].result.overlap, 0) > group.reduce((s, j) => s + usable[j].result.overlap, 0));
    if (better) group = members;
  }

  if (group.length === 1 && usable.length > 1) return no('the references disagree with each other');
  if (group.length === 1 && usable[group[0]].result.overlap < singleMin) {
    return no('a single reference that does not fit convincingly', usable[group[0]].result.overlap);
  }

  const chosen = group.map(j => usable[j]).sort((a, b) => b.result.overlap - a.result.overlap)[0].result;
  const confidence = Math.round((group.reduce((s, j) => s + usable[j].result.overlap, 0) / group.length) * 100) / 100;
  const maxShift = Math.max(...chosen.offsets.map(o => Math.abs(o)));
  if (Math.abs(chosen.ratio - 1) < 0.0005 && maxShift < 0.3) {
    return { apply: false, offset: 0, ratio: 1, segments: chosen.segments.length, confidence, agreeing: group.length, reason: 'already aligned' };
  }
  return {
    apply: true,
    result: chosen,
    offset: Math.round(median(chosen.offsets) * 10) / 10,
    ratio: Math.round(chosen.ratio * 1000) / 1000,
    segments: chosen.segments.length,
    confidence,
    agreeing: group.length,
    reason: `${group.length} reference(s) agree`
  };
}
