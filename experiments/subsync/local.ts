/**
 * Offline experiment, step 3: how the offset between a Romanian subtitle and a reference changes over time.
 * Constant offset = simple shift; growing offset = frame-rate drift; jump = missing/extra segment (recap, logo).
 *
 * Usage: npx tsx experiments/subsync/local.ts <dataDir> <roRank> <engRank> [windowSec]
 */
import fs from 'fs';
import path from 'path';
import { parseCues, localOffsets, IndexItem } from './analyze';

const [dataDir, roArg, enArg, winArg] = process.argv.slice(2);
const index: IndexItem[] = JSON.parse(fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8'));
const pick = (lang: string, rank: string): IndexItem => {
  const i = index.find(x => x.lang === lang && x.rank === Number(rank));
  if (!i) throw new Error('not found ' + lang + ' #' + rank);
  return i;
};
const ro = pick('ron', roArg);
const en = pick('eng', enArg);
const rows = localOffsets(
  parseCues(fs.readFileSync(path.join(dataDir, ro.file), 'utf8')),
  parseCues(fs.readFileSync(path.join(dataDir, en.file), 'utf8')),
  Number(winArg) || 240
);
console.log('RO#' + ro.rank + ' ' + ro.release + '\n vs EN#' + en.rank + ' ' + en.release);
for (const r of rows) {
  console.log('  t=' + String(Math.round(r.from / 60)).padStart(2) + 'min  offset=' + r.offset.toFixed(1).padStart(6) + 's  F1=' + r.score.toFixed(2) + '  cues=' + r.cues);
}
