/**
 * Offline experiment, step 1: collect candidate subtitles (Romanian + English) for one episode/movie
 * from the deployed addon and save them locally. Nothing here is part of the deployed app.
 *
 * Usage: SUBS2B_UUID=<config uuid> npx tsx experiments/subsync/collect.ts <type> <id> <filename> [outDir]
 *   e.g. npx tsx experiments/subsync/collect.ts series tt2234222:3:1 "Orphan Black S03E01 ... playWEB.mkv"
 */
import fs from 'fs';
import path from 'path';

const BASE = process.env.SUBS2B_BASE || 'https://subs2b.onrender.com';
const UUID = process.env.SUBS2B_UUID || '';
const [type, id, filename, outArg] = process.argv.slice(2);
if (!UUID || !type || !id) {
  console.error('Usage: SUBS2B_UUID=... tsx collect.ts <type> <id> <filename> [outDir]');
  process.exit(1);
}
const outDir = outArg || path.join(process.env.TEMP || '.', 'subsync-data');
fs.mkdirSync(outDir, { recursive: true });

interface ListItem { id: string; lang: string; url: string; title?: string }

async function getJson(url: string): Promise<{ subtitles?: ListItem[] }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for list');
  return (await res.json()) as { subtitles?: ListItem[] };
}

async function download(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 90);
}

async function main(): Promise<void> {
  const q = new URLSearchParams({ type, id, lang: 'eng', filename: filename || '' });
  const eng = await getJson(BASE + '/' + UUID + '/debug/search.json?' + q.toString());
  const roUrl =
    BASE + '/' + UUID + '/subtitles/' + type + '/' + encodeURIComponent(id) + '/filename=' + encodeURIComponent(filename || '') + '.json';
  const ron = await getJson(roUrl);

  const plan: Array<{ lang: string; rank: number; item: ListItem }> = [];
  (ron.subtitles || []).forEach((item, i) => plan.push({ lang: 'ron', rank: i + 1, item }));
  (eng.subtitles || []).slice(0, 10).forEach((item, i) => plan.push({ lang: 'eng', rank: i + 1, item }));

  console.log('candidates: ron=' + (ron.subtitles || []).length + ' eng=' + (eng.subtitles || []).length + ' (downloading up to 10 eng)');
  const index: Array<{ file: string; lang: string; rank: number; release: string }> = [];

  for (const p of plan) {
    const text = await download(p.item.url);
    if (!text || text.length < 200) {
      console.log('  skip ' + p.lang + ' #' + p.rank + ' (download failed) ' + (p.item.title || ''));
      continue;
    }
    const file = p.lang + '_' + String(p.rank).padStart(2, '0') + '_' + safeName(p.item.title || p.item.id) + '.srt';
    fs.writeFileSync(path.join(outDir, file), text);
    index.push({ file, lang: p.lang, rank: p.rank, release: p.item.title || '' });
    console.log('  saved ' + file + ' (' + text.length + ' bytes)');
    await new Promise(r => setTimeout(r, 400));
  }
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2));
  console.log('done -> ' + outDir);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
