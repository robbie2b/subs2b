/**
 * Offline experiment, step 2: measure how well Romanian subtitles line up (in time) with English references.
 * Only the cue timings are compared (when lines appear/disappear), never the text, so language does not matter.
 *
 * Usage: npx tsx experiments/subsync/analyze.ts <dataDir>
 */
import fs from 'fs';
import path from 'path';

export interface Cue { start: number; end: number }
export interface IndexItem { file: string; lang: string; rank: number; release: string }

const dataDir = process.argv[2] || path.join(process.env.TEMP || '.', 'subsync-data');

export function parseCues(text: string): Cue[] {
  const cues: Cue[] = [];
  const re = /(\d+):(\d\d):(\d\d)[,.](\d{1,3})\s*-->\s*(\d+):(\d\d):(\d\d)[,.](\d{1,3})/g;
  let m: RegExpExecArray | null;
  const ms = (v: string): number => parseInt(v.padEnd(3, '0'), 10);
  while ((m = re.exec(text)) !== null) {
    const start = +m[1] * 3600 + +m[2] * 60 + +m[3] + ms(m[4]) / 1000;
    const end = +m[5] * 3600 + +m[6] * 60 + +m[7] + ms(m[8]) / 1000;
    if (end > start) cues.push({ start, end });
  }
  return cues;
}

/** Speech-activity vector: 1 where a cue is on screen, sampled every `res` seconds */
export function activity(cues: Cue[], res: number, scale = 1, offset = 0, length = 0): Uint8Array {
  let maxEnd = 0;
  for (const c of cues) maxEnd = Math.max(maxEnd, c.end * scale + offset);
  const n = Math.max(length, Math.ceil(maxEnd / res) + 2);
  const v = new Uint8Array(n);
  for (const c of cues) {
    const a = Math.max(0, Math.floor((c.start * scale + offset) / res));
    const b = Math.min(n - 1, Math.ceil((c.end * scale + offset) / res));
    for (let i = a; i <= b; i++) v[i] = 1;
  }
  return v;
}

export function f1(a: Uint8Array, b: Uint8Array, shift: number): number {
  // compare a[i] with b[i + shift]
  let inter = 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i]) sa++;
    const j = i + shift;
    if (j >= 0 && j < b.length && b[j]) {
      sb++;
      if (a[i]) inter++;
    }
  }
  // count all of b's active samples in the compared window for a fair union
  let sbAll = 0;
  for (let j = 0; j < b.length; j++) if (b[j]) sbAll++;
  const denom = sa + sbAll;
  return denom ? (2 * inter) / denom : 0;
}

interface Fit { scale: number; offset: number; score: number }

/** Best (scale, offset) that maps RO timeline onto the reference; coarse 1 s search then 0.1 s refinement */
export function bestFit(ro: Cue[], ref: Cue[], maxShift = 180): Fit {
  const scales = [1, 25 / 23.976, 23.976 / 25, 24 / 23.976, 23.976 / 24, 25 / 24, 24 / 25, 1.001, 0.999];
  const refCoarse = activity(ref, 1);
  let best: Fit = { scale: 1, offset: 0, score: -1 };
  for (const scale of scales) {
    const roCoarse = activity(ro, 1, scale);
    for (let shift = -maxShift; shift <= maxShift; shift++) {
      const s = f1(roCoarse, refCoarse, shift);
      if (s > best.score) best = { scale, offset: -shift, score: s };
    }
  }
  // refine at 0.1 s around the coarse optimum (+-2 s)
  const refFine = activity(ref, 0.1);
  const roFine = activity(ro, 0.1, best.scale);
  let fine: Fit = { ...best, score: -1 };
  for (let shift = Math.round(-best.offset * 10) - 20; shift <= Math.round(-best.offset * 10) + 20; shift++) {
    const s = f1(roFine, refFine, shift);
    if (s > fine.score) fine = { scale: best.scale, offset: -shift / 10, score: s };
  }
  return fine;
}

/** Local offsets: split the RO timeline in windows and find, per window, the best shift against the reference */
export function localOffsets(ro: Cue[], ref: Cue[], windowSec = 240): Array<{ from: number; offset: number; score: number; cues: number }> {
  const out: Array<{ from: number; offset: number; score: number; cues: number }> = [];
  const refFine = activity(ref, 0.5);
  const end = Math.max(...ro.map(c => c.end));
  for (let t = 0; t < end; t += windowSec) {
    const part = ro.filter(c => c.start >= t && c.start < t + windowSec);
    if (part.length < 5) continue;
    const roA = activity(part.map(c => ({ start: c.start - t, end: c.end - t })), 0.5);
    let best = { offset: 0, score: -1 };
    for (let shift = -240; shift <= 240; shift++) {
      // ro window starts at t; reference index of time t is t/0.5
      const s = f1(roA, refFine, Math.round(t / 0.5) + shift);
      if (s > best.score) best = { offset: shift * 0.5, score: s };
    }
    out.push({ from: t, offset: best.offset, score: Math.round(best.score * 100) / 100, cues: part.length });
  }
  return out;
}

function main(): void {
  const index: IndexItem[] = JSON.parse(fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8'));
  const load = (i: IndexItem): Cue[] => parseCues(fs.readFileSync(path.join(dataDir, i.file), 'utf8'));
  const ro = index.filter(i => i.lang === 'ron');
  const en = index.filter(i => i.lang === 'eng');

  console.log('\nRomanian candidates (rank in list) and cue counts; cues in first 180 s (recap zone):');
  for (const r of ro) {
    const cues = load(r);
    const early = cues.filter(c => c.start < 180).length;
    console.log('  RO#' + r.rank + ' cues=' + cues.length + ' first3min=' + early + ' last=' + Math.round(Math.max(...cues.map(c => c.end))) + 's  ' + r.release);
  }
  console.log('\nEnglish references:');
  for (const e of en) {
    const cues = load(e);
    const early = cues.filter(c => c.start < 180).length;
    console.log('  EN#' + e.rank + ' cues=' + cues.length + ' first3min=' + early + ' last=' + Math.round(Math.max(...cues.map(c => c.end))) + 's  ' + e.release);
  }

  console.log('\nGlobal fit of each Romanian candidate against each English reference (offset = seconds to ADD to the RO times, scale = time stretch, F1 = overlap 0..1):');
  for (const r of ro) {
    const roCues = load(r);
    const row: string[] = [];
    for (const e of en) {
      const fit = bestFit(roCues, load(e));
      row.push('EN#' + e.rank + ': off=' + fit.offset.toFixed(1) + 's sc=' + fit.scale.toFixed(4) + ' F1=' + fit.score.toFixed(2));
    }
    console.log('  RO#' + r.rank + ' ' + r.release);
    row.forEach(x => console.log('       ' + x));
  }

  console.log('\nEnglish vs English (do the references agree with each other?), fit of each EN against EN#1:');
  if (en.length > 0) {
    const ref = load(en[0]);
    for (const e of en.slice(1)) {
      const fit = bestFit(load(e), ref);
      console.log('  EN#' + e.rank + ' vs EN#1: off=' + fit.offset.toFixed(1) + 's sc=' + fit.scale.toFixed(4) + ' F1=' + fit.score.toFixed(2) + '  ' + e.release);
    }
  }
}

if (require.main === module) main();
