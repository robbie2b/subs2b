/**
 * Runs the real decision pipeline (alignAgainst: several references, agreement check, one-shift then split) on every
 * candidate of a corpus made by collect.ts, and prints what would be done and how long it takes.
 *
 * Usage:  npx tsx experiments/subsync/benchmark/gate.ts <workDir> [case]
 */
import fs from 'fs';
import path from 'path';
import { readCues } from '../../../src/utils/subtitleCues';
import { speechFlags, applyAlignment, TimedCue } from '../../../src/utils/subsync';
import { alignAgainst, Reference } from '../../../src/core/alignment';
import { parseCues, Cue } from '../../../src/utils/timeline';

const corpus = path.join(process.argv[2], 'corpus');
const only = process.argv[3];
const index: Array<{ case: string; role: string; lang: string; title: string; file: string }> = JSON.parse(fs.readFileSync(path.join(corpus, 'index.json'), 'utf8'));
const read = (f: string) => fs.readFileSync(path.join(corpus, f), 'utf8');
const toRef = (e: { lang: string; title: string; file: string }): Reference => {
  const c = readCues(read(e.file));
  const fl = speechFlags(c);
  return { label: `[${e.lang}] ${e.title}`, lang: e.lang, provider: 'corpus', cues: c.map((x, i): TimedCue => ({ start: x.start, end: x.end, speech: fl[i] })) };
};
const hit = (output: Cue[], truth: Cue[]): number => {
  const s = output.map(x => x.start).sort((a, b) => a - b);
  let h = 0;
  for (const c of truth) {
    let near = Infinity;
    for (const v of s) near = Math.min(near, Math.abs(v - c.start));
    if (near <= 0.5) h++;
  }
  return truth.length ? h / truth.length : 0;
};

const times: number[] = [];
for (const cn of [...new Set(index.map(i => i.case))].filter(c => !only || c === only)) {
  const cands = index.filter(i => i.case === cn && i.role === 'cand');
  const refEntries = index.filter(i => i.case === cn && i.role === 'ref');
  const refs = refEntries.map(toRef);
  console.log(`\n=== ${cn}`);
  for (const cand of cands) {
    const text = read(cand.file);
    const t0 = Date.now();
    const r = alignAgainst(text, refs);
    const ms = Date.now() - t0;
    times.push(ms);
    const d = r.decision;
    const out = d.apply ? applyAlignment(text, d.result!) : text;
    const y = refEntries[0];
    console.log(cand.title.slice(0, 50).padEnd(50),
      d.apply ? `APPLY ${d.offset >= 0 ? '+' : ''}${d.offset}s x${d.ratio} ${d.segments} part(s) conf ${d.confidence}` : `no: ${d.reason}`.padEnd(38),
      `| vs ${y.lang}: ${(hit(parseCues(text), parseCues(read(y.file))) * 100).toFixed(0)}% -> ${(hit(parseCues(out), parseCues(read(y.file))) * 100).toFixed(0)}% | ${ms} ms`);
  }
}
const s = times.slice().sort((a, b) => a - b);
console.log(`\nalignAgainst: median ${s[Math.floor(s.length / 2)]} ms, max ${s[s.length - 1]} ms over ${s.length} subtitles`);
