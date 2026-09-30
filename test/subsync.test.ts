import os from 'os';
import fs from 'fs';
import path from 'path';

// A private data folder for the configuration store, set before anything reads it
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subs2b-subsync-'));
process.env.DATA_DIR = dataDir;
delete process.env.DATABASE_URL;
process.env.SUBSYNC_BUDGET_MS = '1500';

import axios from 'axios';
import { parseCues, fitOffset, decideAlignment } from '../src/utils/timeline';
import { shiftSubtitle } from '../src/utils/subtitleFormat';
import { needsReference, pickReferenceCandidates, clearReferenceCache, getAlignments } from '../src/core/alignment';
import { getAggregatedSubtitles, parseSubtitleQuery } from '../src/core/aggregator';
import { createAlignedHandler } from '../src/proxy/alignedProxy';
import { decodeAlignedToken } from '../src/core/alignedToken';
import { OpenSubtitlesProvider } from '../src/providers/openSubtitles';
import { SubDLProvider } from '../src/providers/subdl';
import { SubsourceProvider } from '../src/providers/subsource';
import { configStorage } from '../src/storage/configStore';
import { mergeWithDefaults } from '../src/config/userConfig';
import { globalSubtitleCache } from '../src/utils/cache';
import { RawSubtitleItem, SubtitleQuery } from '../src/types/provider';

let failed = 0;
function check(label: string, ok: boolean, info?: unknown): void {
  if (ok) console.log('  ok  ' + label);
  else {
    failed++;
    console.error('FAIL ' + label, info !== undefined ? JSON.stringify(info) : '');
  }
}

// ---------- synthetic subtitles with a known timeline ----------
function makeBase(seed = 7, count = 320): Array<{ start: number; end: number }> {
  let x = seed;
  const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
  const cues: Array<{ start: number; end: number }> = [];
  let t = 4;
  for (let i = 0; i < count; i++) {
    const dur = 1 + rnd() * 3;
    cues.push({ start: t, end: t + dur });
    t += dur + 0.5 + rnd() * 9;
  }
  return cues;
}

const stamp = (sec: number): string => {
  const ms = Math.round(sec * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
};

function toSrt(cues: Array<{ start: number; end: number }>, shift = 0, word = 'text'): string {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start + shift)} --> ${stamp(c.end + shift)}\n${word} ${i}\n`).join('\n');
}

const BASE = makeBase();

async function main() {
  // ============ timeline maths ============
  console.log('Timeline');
  {
    const parsed = parseCues(toSrt(BASE));
    check('cue times are read', parsed.length === BASE.length && Math.abs(parsed[3].start - BASE[3].start) < 0.002);
    check('WebVTT times without hours are read', parseCues('WEBVTT\n\n01:02.500 --> 01:04.000\nhi').length === 1);

    const truth = parseCues(toSrt(BASE));
    const late = parseCues(toSrt(BASE, +5, 'outro text'));
    const fit = fitOffset(late, truth);
    check('a subtitle 5 s late needs -5 s to line up (sign check)', Math.abs(fit.offset - -5) <= 0.1 && fit.score > 0.95, fit);
    const early = fitOffset(parseCues(toSrt(BASE, -3.4)), truth);
    check('a subtitle 3.4 s early needs +3.4 s', Math.abs(early.offset - 3.4) <= 0.1, early);
    const same = fitOffset(parseCues(toSrt(BASE)), truth);
    check('an aligned subtitle gets 0', Math.abs(same.offset) <= 0.1 && same.score > 0.99, same);

    // a different translation: some cues merged/split/missing, still the same timeline
    const other = BASE.filter((_, i) => i % 9 !== 0).map(c => ({ start: c.start + 5 + (Math.random() - 0.5) * 0.2, end: c.end + 5 }));
    const noisy = fitOffset(parseCues(toSrt(other)), truth);
    check('missing cues and small jitter do not break it', Math.abs(noisy.offset - -5) <= 0.3 && noisy.score > 0.8, noisy);

    const unrelated = fitOffset(parseCues(toSrt(makeBase(99, 320))), truth);
    check('unrelated timelines score low', unrelated.score < 0.8, unrelated);
  }

  console.log('Decision');
  {
    check('two references that agree: shift', (() => { const d = decideAlignment([{ offset: -5, score: 0.99 }, { offset: -4.9, score: 0.87 }]); return d.apply && Math.abs(d.offset - -4.95) < 0.06; })());
    check('two references that disagree: no shift', decideAlignment([{ offset: -5, score: 0.95 }, { offset: 12, score: 0.95 }]).apply === false);
    check('one very good reference: shift', decideAlignment([{ offset: -5, score: 0.97 }]).apply === true);
    check('one mediocre reference: no shift', decideAlignment([{ offset: -5, score: 0.84 }]).apply === false);
    check('poor fits are ignored', decideAlignment([{ offset: -5, score: 0.5 }, { offset: -5, score: 0.6 }]).apply === false);
    check('a tiny shift is not applied', decideAlignment([{ offset: 0.1, score: 0.99 }, { offset: 0.2, score: 0.99 }]).apply === false);
    check('an absurd shift is refused', decideAlignment([{ offset: 200, score: 0.99 }, { offset: 200, score: 0.99 }]).apply === false);
    check('no references: no shift', decideAlignment([]).apply === false);
  }

  console.log('Shifting text');
  {
    const shifted = shiftSubtitle(toSrt(BASE.slice(0, 3)), -5);
    const times = parseCues(shifted);
    check('cues before the start of the video are dropped', times.length === 2 || times.length === 3, times);
    const s2 = shiftSubtitle('1\n00:00:10,000 --> 00:00:12,500\nHello\nworld\n\n2\n00:01:00,000 --> 00:01:02,000\nBye\n', -4.6);
    check('times move by the offset, text kept', s2.includes('00:00:05,400 --> 00:00:07,900\nHello\nworld') && s2.includes('00:00:55,400 --> 00:00:57,400\nBye'), s2);
    const s3 = shiftSubtitle('1\n00:00:02,000 --> 00:00:04,000\nA\n\n2\n00:00:07,000 --> 00:00:09,000\nB\n', -5);
    check('a cue ending before 0 is dropped, the next is renumbered', !s3.includes('A') && s3.startsWith('1\n00:00:02,000 --> 00:00:04,000\nB'), s3);
    const s4 = shiftSubtitle('1\n00:00:03,000 --> 00:00:06,000\nStraddles\n', -5);
    check('a cue that starts before 0 is clamped', s4.includes('00:00:00,000 --> 00:00:01,000'), s4);
    const s5 = shiftSubtitle('WEBVTT\n\n00:10.000 --> 00:12.000 align:start\nfrom vtt\n', 2);
    check('WebVTT input comes out as SRT', s5.includes('00:00:12,000 --> 00:00:14,000') && !s5.includes('WEBVTT'), s5);
    check('later shift', shiftSubtitle('1\n00:00:01,000 --> 00:00:02,000\nx\n', 1.5).includes('00:00:02,500 --> 00:00:03,500'));
  }

  // ============ when is a reference needed ============
  console.log('Trigger rule');
  const item = (release: string, provider = 'subdl', lang = 'ron', extra: Partial<RawSubtitleItem> = {}): RawSubtitleItem =>
    ({ id: provider + release, provider, providerName: provider, url: '/sub/proxy?url=x', lang, release, ...extra });
  const CRU = 'Peacemaker.S01E01.2160p.PL.HMAX.WEB-DL.DDPA5.1.HDR.DV.HEVC-CRU.mkv';
  {
    const hdOnly = [
      item('Peacemaker.2022.S01E01.1080p.HMAX.WEB-DL.DD5.1.H.264-FLUX'),
      item('Peacemaker.2022.S01E01.720p.HMAX.WEB-DL.DD5.1.H.264-NTb'),
      item('Peacemaker.2022.S01E01.WEBRip.x264-ION10')
    ];
    const v1 = needsReference(CRU, hdOnly);
    check('Peacemaker case: 2160p file, only HD subtitles of other groups -> a reference is needed', v1.needed, v1);

    const v2 = needsReference('Movie.2020.2160p.WEB-DL.HEVC-FLUX.mkv', [item('Movie.2020.1080p.WEB-DL.x264-FLUX'), item('Movie.2020.1080p.BluRay-OTHER')]);
    check('2160p-FLUX file with a 1080p-FLUX subtitle -> no reference (the rule you set)', !v2.needed, v2);

    const v3 = needsReference(CRU, [...hdOnly, item('Peacemaker.S01E01.2160p.WEB-DL.HEVC-SOMEONE')]);
    check('a 2160p subtitle of another group is compatible (same class) -> no reference', !v3.needed, v3);

    const v4 = needsReference('Movie.2020.1080p.WEB-DL.x264-AAA.mkv', [item('Movie.2020.720p.BluRay.x264-BBB')]);
    check('HD file with HD subtitles -> no reference', !v4.needed, v4);

    const v5 = needsReference('Movie.2020.1080p.WEB-DL.x264-AAA.mkv', [item('Movie.2020.2160p.WEB-DL.HEVC-BBB')]);
    check('HD file with only 2160p subtitles of another group -> a reference is needed', v5.needed, v5);

    check('no file name -> nothing changes', !needsReference(undefined, hdOnly).needed);
    check('file name without resolution -> nothing changes', !needsReference('Peacemaker.S01E01.mkv', hdOnly).needed);
    check('subtitles without any resolution info -> nothing changes', !needsReference(CRU, [item('Peacemaker.WEBRip.x264-ION10'), item('Peacemaker XviD-AFG')]).needed);
    check('nothing found -> nothing changes', !needsReference(CRU, []).needed);
  }

  console.log('Reference candidates');
  {
    const found = [
      item('Peacemaker.2022.S01E01.NORDiC.2160p.DV.HDR.WEB.HEVC-DRAUGR', 'subsource', 'fin'),
      item('Peacemaker.S01.2160p.Max.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-SPAMKINGS', 'subdl', 'ara'),
      item('Peacemaker.2022.S01E01.1080p.HMAX.WEB-DL.DD5.1.H.264-NTb', 'subdl', 'eng'),
      item('Peacemaker.2022.S01E01.2160p.WEB.HEVC-FORCED.forced', 'subdl', 'eng'),
      item('Peacemaker.2022.S01E01.2160p.CAM.x264-BAD', 'subdl', 'eng'),
      item('Other.Show.S01E01.2160p.WEB-DL.HEVC-XYZ', 'subdl', 'fra')
    ];
    const picked = pickReferenceCandidates(found, CRU, 1, 1).map(i => i.lang);
    check('only 2160p subtitles of the right title, any language', picked.includes('fin') && picked.includes('ara') && picked.length === 2, picked);
    check('HD, forced, CAM and other titles are not references', !picked.includes('fra') && picked.length === 2);
  }

  // ============ the whole thing, with a faked network ============
  console.log('End to end');
  const TRUTH = BASE;                         // timeline of the playing 2160p file (what the references have)
  const LATE = 5;                             // the HD-based Romanian subtitle is 5 s late
  const REF_FIN = toSrt(TRUTH, 0.05, 'finnish');
  const REF_ARA = toSrt(TRUTH.filter((_, i) => i % 7 !== 3), -0.05, 'arabic');
  const RO_HD = toSrt(TRUTH, LATE, 'romana');

  let providerCalls = 0;
  let searchDelayMs = 0;
  const providerItems: RawSubtitleItem[] = [
    { id: 'ref-fin', provider: 'subsource', providerName: 'Subsource', url: '/sub/proxy?url=' + encodeURIComponent('https://dl.subsource.net/fin.zip'), lang: 'fin', release: 'Peacemaker.2022.S01E01.NORDiC.2160p.DV.HDR.WEB.HEVC-DRAUGR' },
    { id: 'ref-ara', provider: 'subdl', providerName: 'SubDL', url: '/sub/proxy?url=' + encodeURIComponent('https://dl.subdl.com/ara.zip'), lang: 'ara', release: 'Peacemaker.S01.2160p.Max.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-SPAMKINGS' }
  ];
  const stubSearch = async (_q: SubtitleQuery): Promise<RawSubtitleItem[]> => {
    providerCalls++;
    if (searchDelayMs) await new Promise(r => setTimeout(r, searchDelayMs));
    return providerItems;
  };
  (OpenSubtitlesProvider.prototype as any).executeSearch = async (q: SubtitleQuery) => stubSearch(q);
  (SubDLProvider.prototype as any).executeSearch = async () => [];
  (SubsourceProvider.prototype as any).executeSearch = async () => [];

  const realGet = axios.get;
  const fetched: string[] = [];
  (axios as any).get = async (url: string) => {
    fetched.push(url);
    const body = (text: string) => ({ status: 200, data: new Uint8Array(Buffer.from(text)).buffer, headers: {} });
    if (url.includes('fin.zip')) return body(REF_FIN);
    if (url.includes('ara.zip')) return body(REF_ARA);
    if (url.includes('/ro-hd')) return body(RO_HD);
    if (url.includes('/ro-empty')) return body('1\n00:00:01,000 --> 00:00:02,000\nshort\n');
    throw new Error('unexpected fetch ' + url);
  };

  const uuid = '0a1b2c3d-1111-4222-8333-444455556666';
  const config = mergeWithDefaults({ languages: ['ron'], providers: { opensubtitles: { enabled: true, apiKey: 'test-key-1234567890' } } });
  await configStorage.saveConfigAsync(uuid, 'pw12345', config);
  const stored = (await configStorage.getConfigByUuidAsync(uuid))!;
  const baseUrl = 'http://localhost:7011';

  // -- the list: links are wrapped only when a reference is needed --
  {
    globalSubtitleCache.clear?.();
    providerItems.push({ id: 'ro-flux', provider: 'subdl', providerName: 'SubDL', url: baseUrl + '/ro-hd', lang: 'ron', release: 'Peacemaker.2022.S01E01.1080p.HMAX.WEB-DL.DD5.1.H.264-FLUX' });
    // the list search asks for Romanian only: the stub filters like a real provider would
    (OpenSubtitlesProvider.prototype as any).executeSearch = async (q: SubtitleQuery) => {
      await stubSearch(q);
      return q.allLanguages ? providerItems : providerItems.filter(i => i.lang === 'ron');
    };
    const q = parseSubtitleQuery('series', 'tt13146488:1:1', { filename: CRU });
    const list = await getAggregatedSubtitles(q, stored, baseUrl, uuid);
    const wrapped = list.subtitles.filter(s => s.url.includes('/sub/aligned/'));
    check('BEFORE/AFTER: with only an HD subtitle for a 2160p file, the link is wrapped', list.subtitles.length === 1 && wrapped.length === 1, list.subtitles.map(s => s.url));
    const token = decodeAlignedToken((wrapped[0]?.url.split('/sub/aligned/')[1] || '').replace('.srt', ''));
    check('the link carries the real subtitle, the content and the file name', token?.u === baseUrl + '/ro-hd' && token?.id === 'tt13146488:1:1' && token?.f === CRU, token);

    const sameGroup = parseSubtitleQuery('series', 'tt13146488:1:2', { filename: 'Peacemaker.S01E02.2160p.HMAX.WEB-DL.HEVC-FLUX.mkv' });
    globalSubtitleCache.clear?.();
    const list2 = await getAggregatedSubtitles(sameGroup, stored, baseUrl, uuid);
    check('same group (FLUX, other resolution): links are left alone', list2.subtitles.every(s => !s.url.includes('/sub/aligned/')), list2.subtitles.map(s => s.url));

    globalSubtitleCache.clear?.();
    const off = await getAggregatedSubtitles(q, { ...stored, subsync: false }, baseUrl, uuid);
    check('switched off in the configuration: links are left alone', off.subtitles.every(s => !s.url.includes('/sub/aligned/')));

    globalSubtitleCache.clear?.();
    const noName = await getAggregatedSubtitles(parseSubtitleQuery('series', 'tt13146488:1:1', {}), stored, baseUrl, uuid);
    check('no file name from the player: links are left alone', noName.subtitles.every(s => !s.url.includes('/sub/aligned/')));
  }

  // -- the aligned link: what the player gets --
  const respond = () => {
    const out: { status: number; headers: Record<string, string>; body: string; redirect?: string } = { status: 200, headers: {}, body: '' };
    const res: any = {
      status(c: number) { out.status = c; return res; },
      type() { return res; },
      setHeader(k: string, v: string) { out.headers[k] = v; },
      send(b: string) { out.body = String(b); return res; },
      redirect(c: number, u: string) { out.status = c; out.redirect = u; return res; }
    };
    return { res, out };
  };
  const handler = createAlignedHandler(() => baseUrl);
  const linkFor = (u: string, name = 'Peacemaker.2022.S01E01.1080p.HMAX.WEB-DL.DD5.1.H.264-FLUX') =>
    Buffer.from(JSON.stringify({ u, id: 'tt13146488:1:1', t: 'series', f: CRU, r: name })).toString('base64url');

  {
    clearReferenceCache();
    providerCalls = 0;
    const before = parseCues(RO_HD);
    const r = respond();
    const t0 = Date.now();
    await handler({ params: { config: uuid, data: linkFor(baseUrl + '/ro-hd') }, query: {} } as any, r.res);
    const after = parseCues(r.out.body);
    const worst = Math.max(...after.map((c, i) => Math.abs(c.start - TRUTH[i].start)));
    check('the subtitle that reaches the player is 5 s earlier than the original', r.out.status === 200 && Math.abs(before[10].start - after[10].start - 5) < 0.15, { first: before[10].start, now: after[10].start });
    check('and lines up with the real timeline (max error under 0.2 s)', worst < 0.2, worst);
    check('the text is untouched', r.out.body.includes('romana 10') && r.out.body.includes('romana 300'));
    check('it was quick', Date.now() - t0 < 1500, Date.now() - t0);
    const log = getAlignments(uuid)[0];
    check('the decision is recorded for the Debug page', log?.outcome === 'shifted' && Math.abs(log.offset - -5) < 0.2 && log.references.length === 2, log);
    check('an all-language search was made once', providerCalls === 1, providerCalls);

    const again = respond();
    const callsBefore = providerCalls;
    await handler({ params: { config: uuid, data: linkFor(baseUrl + '/ro-hd') }, query: {} } as any, again.res);
    check('the second request is served from the cache (no new search)', providerCalls === callsBefore && again.out.body === r.out.body);
  }

  {
    // an episode with no usable reference: the subtitle is sent as it is
    clearReferenceCache();
    const saved = providerItems.splice(0, providerItems.length);
    const r = respond();
    await handler({ params: { config: uuid, data: linkFor(baseUrl + '/ro-hd').replace(/./, m => m) }, query: {} } as any, r.res);
    // (same link as before is cached, so use another subtitle link)
    const r2 = respond();
    await handler({ params: { config: uuid, data: linkFor(baseUrl + '/ro-hd?x=2') }, query: {} } as any, r2.res);
    check('no reference found: the subtitle is sent unchanged', r2.out.status === 200 && r2.out.body === RO_HD.replace(/\r\n/g, '\n').trim() + '\n' || r2.out.body.includes('romana 10'), r2.out.status);
    check('unchanged means the same times', Math.abs(parseCues(r2.out.body)[10].start - parseCues(RO_HD)[10].start) < 0.002);
    check('the outcome says why', getAlignments(uuid)[0].outcome === 'unchanged' && /no reference/.test(getAlignments(uuid)[0].reason), getAlignments(uuid)[0]);
    providerItems.push(...saved);
  }

  {
    // slow search: over budget, the player gets the original at once and the next request gets the result
    clearReferenceCache();
    searchDelayMs = 2500;
    const link = linkFor(baseUrl + '/ro-hd?slow=1');
    const r = respond();
    const t0 = Date.now();
    await handler({ params: { config: uuid, data: link }, query: {} } as any, r.res);
    const took = Date.now() - t0;
    check('over budget: answered within the budget (1.5 s) with the original', took < 2200 && Math.abs(parseCues(r.out.body)[10].start - parseCues(RO_HD)[10].start) < 0.002, took);
    check('and not cached by the player', r.out.headers['Cache-Control'] === 'no-store', r.out.headers);
    check('the outcome is "timeout"', getAlignments(uuid)[0].outcome === 'timeout');
    await new Promise(r2 => setTimeout(r2, 2600));
    const next = respond();
    await handler({ params: { config: uuid, data: link }, query: {} } as any, next.res);
    check('the next request finds it aligned', Math.abs(parseCues(next.out.body)[10].start - (parseCues(RO_HD)[10].start - 5)) < 0.15, parseCues(next.out.body)[10].start);
    searchDelayMs = 0;
  }

  {
    // safety
    const bad = respond();
    await handler({ params: { config: uuid, data: linkFor('https://169.254.169.254/latest/meta-data') }, query: {} } as any, bad.res);
    check('a link to any other host is refused (no open proxy)', bad.out.status === 400, bad.out.status);
    const junk = respond();
    await handler({ params: { config: uuid, data: 'garbage' }, query: {} } as any, junk.res);
    check('a malformed link is refused', junk.out.status === 400);
    const stranger = respond();
    await handler({ params: { config: '99999999-1111-4222-8333-444455556666', data: linkFor(baseUrl + '/ro-hd') }, query: {} } as any, stranger.res);
    check('an unknown configuration is refused', stranger.out.status === 400);

    const off = respond();
    await configStorage.saveConfigAsync(uuid, 'pw12345', { ...stored, subsync: false });
    await handler({ params: { config: uuid, data: linkFor(baseUrl + '/ro-hd?off=1') }, query: {} } as any, off.res);
    check('switched off: the subtitle passes through unchanged', Math.abs(parseCues(off.out.body)[10].start - parseCues(RO_HD)[10].start) < 0.002);
  }

  (axios as any).get = realGet;
  fs.rmSync(dataDir, { recursive: true, force: true });

  if (failed) {
    console.error(failed + ' subsync check(s) failed');
    process.exit(1);
  }
  console.log('All subsync checks passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
