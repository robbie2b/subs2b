/**
 * Collects a small corpus (candidate subtitles + timing references) from a deployed subs2b into a folder.
 * The subtitle files contain text, so keep the folder OUT of the repository.
 *
 * Usage:  SUBS2B_UUID=<configuration uuid> [SUBS2B_BASE=https://subs2b.onrender.com] npx tsx experiments/subsync/benchmark/collect.ts <outDir>
 * Edit `cases` below to study other titles.
 */
import fs from 'fs';
import path from 'path';

const OUT = process.argv[2];
const UUID = process.env.SUBS2B_UUID || '';
const BASE = (process.env.SUBS2B_BASE || 'https://subs2b.onrender.com') + '/' + UUID + '/debug/search.json';
if (!OUT || !UUID) {
  console.error('Usage: SUBS2B_UUID=... npx tsx collect.ts <outDir>');
  process.exit(1);
}

interface Case {
  name: string;
  type: string;
  id: string;
  file: string;
  candidates: { lang: string; take: number; match?: RegExp }[];
  refs: { lang: string; match: RegExp; take?: number }[];
}

const cases: Case[] = [
  {
    name: 'peacemaker', type: 'series', id: 'tt13146488:1:1',
    file: 'Peacemaker.S01E01.2160p.PL.HMAX.WEB-DL.DDPA5.1.HDR.DV.HEVC-CRU.mkv',
    candidates: [{ lang: 'ron', take: 3 }],
    refs: [{ lang: 'fin', match: /2160p.*DRAUGR/i }, { lang: 'ara', match: /2160p.*SPAMKINGS/i }]
  },
  {
    name: 'hotd_kitsune', type: 'series', id: 'tt11198330:1:1',
    file: 'House.of.the.Dragon.S01E01.The.Heirs.of.the.Dragon.2160p.MAX.WEB-DL.TrueHD.7.1.Atmos.DV.HDR.H.265-Kitsune.mkv',
    candidates: [{ lang: 'ron', take: 3 }],
    refs: [{ lang: 'msa', match: /Kitsune/i }, { lang: 'ara', match: /2160p/i }]
  },
  {
    name: 'bigbang', type: 'series', id: 'tt0898266:1:6',
    file: 'The.Big.Bang.Theory.S01E06.The.Middle.Earth.Paradigm.1080p.DTS-HD.MA.5.1.AVC.REMUX-FraMeSToR.mkv',
    candidates: [{ lang: 'ron', take: 6 }],
    refs: [{ lang: 'eng', match: /Bluray-10|720p\.BDRip/i, take: 2 }, { lang: 'ita', match: /BrRip/i }, { lang: 'deu', match: /Bluray-10/i }]
  },
  {
    name: 'andor', type: 'series', id: 'tt9253284:1:1',
    file: 'Star.Wars.Andor.S01E01.MULTI.VFF.2160p.UHD.BluRay.Remux.DV.HDR.TrueHD.Atmos.HEVC-HYPERION.mkv',
    candidates: [{ lang: 'ron', take: 3 }],
    refs: [{ lang: 'eng', match: /2160p.*remux/i }, { lang: 'nld', match: /UHD/i }, { lang: 'vie', match: /UHD|2160p/i }]
  }
];

type It = { title: string; url: string };
async function list(c: Case, lang: string): Promise<It[]> {
  const r = await fetch(BASE + '?' + new URLSearchParams({ type: c.type, id: c.id, lang, filename: c.file }));
  return ((await r.json()) as { subtitles: It[] }).subtitles || [];
}
const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 70);

(async () => {
  const index: Array<{ case: string; role: string; lang: string; title: string; file: string }> = [];
  for (const c of cases) {
    const dir = path.join(OUT, c.name);
    fs.mkdirSync(dir, { recursive: true });
    let n = 0;
    const save = async (role: string, lang: string, it: It) => {
      const text = await (await fetch(it.url)).text();
      if (text.length < 500) return;
      const file = `${role}_${String(++n).padStart(2, '0')}_${lang}_${safe(it.title)}.srt`;
      fs.writeFileSync(path.join(dir, file), text);
      index.push({ case: c.name, role, lang, title: it.title, file: `${c.name}/${file}` });
    };
    for (const cd of c.candidates) for (const it of (await list(c, cd.lang)).filter(i => !cd.match || cd.match.test(i.title)).slice(0, cd.take)) await save('cand', cd.lang, it);
    for (const rf of c.refs) for (const it of (await list(c, rf.lang)).filter(i => rf.match.test(i.title)).slice(0, rf.take ?? 1)) await save('ref', rf.lang, it);
    console.log(c.name, 'candidates', index.filter(i => i.case === c.name && i.role === 'cand').length, 'references', index.filter(i => i.case === c.name && i.role === 'ref').length);
  }
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));
})();
