/**
 * Offline experiment: groups the Romanian candidates of one title into "timeline families".
 * Two subtitles are in the same family when one can be laid over the other with (almost) no shift and no stretch,
 * i.e. they were timed against the same video.
 *
 * Usage: npx tsx experiments/subsync/families.ts <dataDir>   (dataDir produced by collect.ts with ONLY_RON=1)
 */
import fs from 'fs';
import path from 'path';
import { parseCues, bestFit, Cue, IndexItem } from './analyze';

const dataDir = process.argv[2];
const index: IndexItem[] = JSON.parse(fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8')).filter((i: IndexItem) => i.lang === 'ron');

interface Cand { item: IndexItem; cues: Cue[]; size: number }
const cands: Cand[] = index.map(item => {
  const text = fs.readFileSync(path.join(dataDir, item.file), 'utf8');
  return { item, cues: parseCues(text), size: text.length };
}).filter(c => c.cues.length > 50);

const parent = cands.map((_, i) => i);
const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
const union = (a: number, b: number): void => { parent[find(a)] = find(b); };

const relations: string[] = [];
for (let i = 0; i < cands.length; i++) {
  for (let j = i + 1; j < cands.length; j++) {
    if (cands[i].size === cands[j].size && cands[i].cues.length === cands[j].cues.length) {
      union(i, j); // identical file under two names
      continue;
    }
    const fit = bestFit(cands[j].cues, cands[i].cues, 120);
    const same = Math.abs(fit.scale - 1) < 0.003 && Math.abs(fit.offset) <= 1.5 && fit.score >= 0.7;
    if (same) union(i, j);
    relations.push(`#${cands[i].item.rank} vs #${cands[j].item.rank}: off=${fit.offset.toFixed(1)}s scale=${fit.scale.toFixed(4)} F1=${fit.score.toFixed(2)}${same ? ' SAME' : ''}`);
  }
}

const groups = new Map<number, number[]>();
cands.forEach((_, i) => {
  const r = find(i);
  groups.set(r, [...(groups.get(r) || []), i]);
});

const ordered = [...groups.values()].sort((a, b) => b.length - a.length);
console.log(`${cands.length} candidates -> ${ordered.length} timeline families`);
ordered.forEach((g, n) => {
  console.log(`\nFamily ${n + 1}: ${g.length} subtitle(s)`);
  g.forEach(i => {
    const c = cands[i];
    const last = Math.round(Math.max(...c.cues.map(x => x.end)));
    console.log(`   #${String(c.item.rank).padStart(2)}  cues=${c.cues.length}  last=${last}s  ${c.item.release}`);
  });
});
if (process.env.SHOW_RELATIONS === '1') console.log('\n' + relations.join('\n'));
