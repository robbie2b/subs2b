/**
 * Compares the subs2b alignment engine with ffsubsync (outputs made by bench.sh) on a corpus made by collect.ts.
 * Metric: share of a held-out reference's cue starts that have a cue start of the output within +-0.5 s
 * (the held-out reference is NOT the one used to align). Higher is better.
 *
 * Usage:  npx tsx experiments/subsync/benchmark/eval.ts <workDir>      (workDir has corpus/ and out/)
 */
import fs from 'fs';
import path from 'path';
import { readCues } from '../../../src/utils/subtitleCues';
import { alignToReference, applyAlignment } from '../../../src/utils/subsync';
import { parseCues, Cue } from '../../../src/utils/timeline';

const WORK = process.argv[2];
const corpus = path.join(WORK, 'corpus');
const out = path.join(WORK, 'out');
const index: Array<{ case: string; role: string; lang: string; title: string; file: string }> = JSON.parse(fs.readFileSync(path.join(corpus, 'index.json'), 'utf8'));
const read = (f: string) => fs.readFileSync(path.join(corpus, f), 'utf8');

function hitRate(output: Cue[], truth: Cue[], tol = 0.5): number {
  const s = output.map(x => x.start).sort((a, b) => a - b);
  if (!truth.length) return 0;
  let hit = 0;
  for (const c of truth) {
    let lo = 0, hi = s.length - 1, near = Infinity;
    while (lo <= hi) { const m = (lo + hi) >> 1; near = Math.min(near, Math.abs(s[m] - c.start)); if (s[m] < c.start) lo = m + 1; else hi = m - 1; }
    if (lo < s.length) near = Math.min(near, Math.abs(s[lo] - c.start));
    if (lo > 0) near = Math.min(near, Math.abs(s[lo - 1] - c.start));
    if (near <= tol) hit++;
  }
  return hit / truth.length;
}
const pct = (n: number) => (isNaN(n) ? '  - ' : (n * 100).toFixed(0).padStart(3) + '%');
const totals: Record<string, number[]> = { original: [], engineGlobal: [], engineSplit: [], ffsubsync: [], ffsubsyncSplit: [] };

for (const cn of [...new Set(index.map(i => i.case))]) {
  const cands = index.filter(i => i.case === cn && i.role === 'cand');
  const refs = index.filter(i => i.case === cn && i.role === 'ref');
  console.log(`\n=== ${cn}`);
  for (const cand of cands) {
    const text = read(cand.file);
    for (const held of refs) {
      const others = refs.filter(r => r.file !== held.file);
      if (!others.length) continue;
      const truth = parseCues(read(held.file));
      const refCues = readCues(read(others[0].file));
      const candCues = readCues(text);
      const g = alignToReference(candCues, refCues, { split: false });
      const s = alignToReference(candCues, refCues, { split: true, splitPenalty: 7 });
      const ffs = (mode: string) => {
        const p = path.join(out, cn, `${path.basename(cand.file, '.srt').slice(0, 8)}__${path.basename(others[0].file, '.srt').slice(0, 8)}.${mode}.srt`);
        return fs.existsSync(p) ? parseCues(fs.readFileSync(p, 'utf8')) : null;
      };
      const r = {
        original: hitRate(parseCues(text), truth),
        engineGlobal: g ? hitRate(parseCues(applyAlignment(text, g)), truth) : NaN,
        engineSplit: s ? hitRate(parseCues(applyAlignment(text, s)), truth) : NaN,
        ffsubsync: ffs('plain') ? hitRate(ffs('plain')!, truth) : NaN,
        ffsubsyncSplit: ffs('split') ? hitRate(ffs('split')!, truth) : NaN
      };
      for (const [k, v] of Object.entries(r)) if (!isNaN(v)) totals[k].push(v);
      console.log(cand.title.slice(0, 44).padEnd(44), (held.lang + ' ' + held.title).slice(0, 12).padEnd(12), Object.values(r).map(pct).join(' '));
    }
  }
}
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
console.log('\ncolumns: original, engine (one shift + ratio), engine (+ split), ffsubsync, ffsubsync --split-penalty');
console.log('mean over all pairs:');
for (const [k, v] of Object.entries(totals)) console.log('  ' + k.padEnd(16), pct(mean(v)), `(${v.length} pairs)`);
