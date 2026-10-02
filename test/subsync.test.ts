import os from 'os';
import fs from 'fs';
import path from 'path';

// A private data folder for the configuration store, set before anything reads it
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subs2b-subsync-'));
process.env.DATA_DIR = dataDir;
delete process.env.DATABASE_URL;
process.env.SUBSYNC_MAX_WAIT_MS = '4000';

import axios from 'axios';
import { parseCues } from '../src/utils/timeline';
import { shiftSubtitle } from '../src/utils/subtitleFormat';
import { needsReference, fromFileGroup, referenceKey, pickReferenceCandidates, clearReferenceCache, getAlignments, referencesAgree, alignAgainst } from '../src/core/alignment';
import { rankSubtitles } from '../src/utils/scorer';
import { getAggregatedSubtitles, parseSubtitleQuery } from '../src/core/aggregator';
import { createAlignedHandler, createFallbackHandler, clearAlignmentDecisions } from '../src/proxy/alignedProxy';
import { deduplicateSubtitles } from '../src/utils/deduplicator';
import { packReferences, unpackReferences } from '../src/storage/referenceStore';
import { noteRefusal, clearSourceHealth, isBlocked, restoreRefusals, attachRefusalStore } from '../src/utils/sourceHealth';
import { decodeFallbackToken } from '../src/core/alignedToken';
import { stopAlignWorker } from '../src/core/alignPool';
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
  // ============ reading cue times ============
  console.log('Reading cue times');
  {
    const parsed = parseCues(toSrt(BASE));
    check('cue times are read', parsed.length === BASE.length && Math.abs(parsed[3].start - BASE[3].start) < 0.002);
    check('WebVTT times without hours are read', parseCues('WEBVTT\n\n01:02.500 --> 01:04.000\nhi').length === 1);
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

    const v2 = needsReference('Movie.2020.2160p.WEB-DL.HEVC-FLUX.mkv', [item('Movie.2020.1080p.WEB-DL.x264-FLUX')]);
    check('2160p-FLUX file with only a 1080p-FLUX subtitle -> no reference (same group is trusted)', !v2.needed, v2);
    const v2b = needsReference('Movie.2020.2160p.WEB-DL.HEVC-FLUX.mkv', [item('Movie.2020.1080p.WEB-DL.x264-FLUX'), item('Movie.2020.1080p.BluRay-OTHER')]);
    check('same-group subtitle plus another group -> the other one is checked', v2b.needed && /1 of 2/.test(v2b.reason), v2b);

    const v3 = needsReference(CRU, [...hdOnly, item('Peacemaker.S01E01.2160p.WEB-DL.HEVC-SOMEONE')]);
    check('a 2160p subtitle of another group is checked too (its label is not trusted)', v3.needed, v3);

    const v4 = needsReference('Movie.2020.1080p.WEB-DL.x264-AAA.mkv', [item('Movie.2020.720p.WEBRip.x264-BBB')]);
    check('HD web file with HD web subtitles of another group -> checked', v4.needed, v4);

    const BBT = 'The.Big.Bang.Theory.S01E06.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-EPSiLON.mkv';
    const bbt = needsReference(BBT, [item('The.Big.Bang.Theory.S01E06.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb'), item('The.Big.Bang.Theory.S01E06.720p.WEBRip.x264-ION10')]);
    check('Big Bang case: 1080p REMUX file, only WEB subtitles -> a reference is needed', bbt.needed, bbt);
    const CHASER = 'The.Chaser.2008.MULTi.1080p.BluRay.Remux.AVC.DTS.HDMA.5.1-Shamir.mkv';
    const chaser = needsReference(CHASER, [item('The.Chaser.2008.BluRay.1080p.DTS-HD.MA.5.1.AVC.REMUX-FraMeSToR')]);
    check('The Chaser case: Shamir REMUX file with a FraMeSToR REMUX subtitle -> checked (same kind is not enough)', chaser.needed, chaser);
    check('subtitle without any info -> checked', needsReference(CRU, [item('Peacemaker.WEBRip.x264-ION10'), item('Peacemaker XviD-AFG')]).needed);
    check('fromFileGroup: same group', fromFileGroup(CHASER, 'The.Chaser.2008.720p.BluRay-Shamir') && !fromFileGroup(CHASER, 'The.Chaser.2008.1080p.REMUX-FraMeSToR'));
    check('fromFileGroup: no file name or no group -> false', !fromFileGroup(undefined, 'X-Shamir') && !fromFileGroup(CHASER, 'The Chaser'));

    check('no file name -> nothing changes', !needsReference(undefined, hdOnly).needed);
    check('file name without resolution -> nothing changes', !needsReference('Peacemaker.S01E01.mkv', hdOnly).needed);
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

    const bbtFound = [
      item('The.Big.Bang.Theory.S01E06.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb', 'subdl', 'eng'),
      item('The.Big.Bang.Theory.S01E06.1080p.BluRay.x264-SHORTBREHD', 'subdl', 'spa'),
      item('The.Big.Bang.Theory.S01E06.720p.BluRay.REMUX-OTHER', 'subsource', 'fre')
    ];
    const bbtPicked = pickReferenceCandidates(bbtFound, 'The.Big.Bang.Theory.S01E06.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-EPSiLON.mkv', 1, 6).map(i => i.lang);
    check('a REMUX file takes only disc references (BluRay/REMUX), not WEB', bbtPicked.length === 2 && !bbtPicked.includes('eng'), bbtPicked);
  }

  {
    // at equal score another service goes first (the OpenSubtitles download quota is kept for the user's picks)
    const tie = [
      item('Peacemaker.2022.S01E01.2160p.WEB.HEVC-SAME', 'opensubtitles', 'eng'),
      item('Peacemaker.2022.S01E01.2160p.WEB.HEVC-SAME', 'subdl', 'spa')
    ];
    const tiePicked = pickReferenceCandidates(tie, CRU, 1, 1).map(i => i.provider);
    check('equal score: SubDL before OpenSubtitles', tiePicked[0] === 'subdl', tiePicked);
    const better = [
      item('Peacemaker.S01E01.2160p.PL.HMAX.WEB-DL.DDPA5.1.HDR.DV.HEVC-CRU', 'opensubtitles', 'eng'),
      item('Peacemaker.2022.S01E01.2160p.WEB.HEVC-OTHER', 'subdl', 'spa')
    ];
    const betterPicked = pickReferenceCandidates(better, CRU, 1, 1).map(i => i.provider);
    check('a better match from OpenSubtitles still goes first (the score decides)', betterPicked[0] === 'opensubtitles', betterPicked);
  }

  console.log('Cut of the film (extended, director\'s cut...)');
  {
    const EXT = 'Movie.2010.Extended.1080p.BluRay.x264-GRP.mkv';
    check('same group but another cut: not trusted, checked', !fromFileGroup(EXT, 'Movie.2010.1080p.BluRay.x264-GRP') && fromFileGroup(EXT, 'Movie.2010.EXTENDED.720p.BluRay.x264-GRP'));
    check('theatrical counts as the usual cut', fromFileGroup('Movie.2010.1080p.BluRay.x264-GRP.mkv', 'Movie.2010.Theatrical.1080p.BluRay.x264-GRP'));
    const refs = pickReferenceCandidates([
      item('Movie.2010.1080p.BluRay.x264-AAA', 'subdl', 'eng'),
      item('Movie.2010.Extended.1080p.BluRay.x264-BBB', 'subdl', 'spa')
    ], EXT, null, null).map(i => i.lang);
    check('references only of the same cut', refs.length === 1 && refs[0] === 'spa', refs);
    check('the cut is part of the reference key', referenceKey('tt1', EXT) !== referenceKey('tt1', 'Movie.2010.1080p.BluRay.x264-GRP.mkv'));
  }

  console.log('Stored references');
  {
    const ref = { label: '[en] X', lang: 'eng', provider: 'subdl', cues: [{ start: 1.234, end: 2.5, speech: true }, { start: 3.001, end: 3.999, speech: false }, { start: 4, end: 4, speech: true }] };
    const back = unpackReferences(packReferences([ref]))[0];
    check('stored and read back with the same times (to the millisecond) and dialogue flags',
      back.label === ref.label && back.cues.length === 3 && Math.abs(back.cues[0].start - 1.234) < 1e-9 && Math.abs(back.cues[1].end - 3.999) < 1e-9 && back.cues[1].speech === false && back.cues[0].speech === true, back);
  }

  console.log('Sources refusing this server');
  {
    noteRefusal('api.opensubtitles.com', 406, 'quota');
    noteRefusal('dl.opensubtitles.org', 403, 'blocked');
    noteRefusal('subs5.strem.io', 469, 'too many');
    const picked = pickReferenceCandidates([
      item('Peacemaker.2022.S01E01.2160p.WEB.HEVC-AAA', 'opensubtitles', 'eng', { url: '/proxy/download/os-rest/1?apiKey=k' }),
      item('Peacemaker.2022.S01E01.2160p.WEB.HEVC-BBB', 'subdl', 'spa')
    ], CRU, 1, 1).map(i => i.provider);
    check('an OpenSubtitles reference is not even tried while its quota is reached', picked.join() === 'subdl', picked);
    clearSourceHealth();
  }

  console.log('Deduplication keeps backups');
  {
    const a = item('Movie.2020.1080p.WEB-DL.x264-AAA', 'org.stremio.subsro', 'ron', { url: 'https://a/1' });
    const b = item('Movie.2020.1080p.WEB-DL.x264-AAA', 'community.opensubtitlesv3.pro', 'ron', { url: 'https://b/1' });
    const c = item('Movie.2020.1080p.WEB-DL.x264-AAA', 'opensubtitles', 'ron', { url: 'https://c/1' });
    const same = item('Movie.2020.1080p.WEB-DL.x264-AAA', 'subdl', 'ron', { url: 'https://a/1' });
    const other = item('Movie.2020.720p.HDTV-ZZZ', 'subdl', 'ron', { url: 'https://d/1' });
    const out = deduplicateSubtitles([a, b, same, c, other]);
    check('duplicates are merged into the first (priority order)', out.length === 2 && out[0].url === 'https://a/1', out.map(o => o.url));
    check('and kept as its backups, in order (a copy with the same link is not a backup)',
      (out[0].backups || []).map(x => x.url).join(',') === 'https://b/1,https://c/1', out[0].backups);
    check('a subtitle without duplicates has no backups', !out[1].backups);
    check('the input items are not changed', !a.backups);
  }

  console.log('Release names in brackets (Subs.ro)');
  {
    const PLAYWEB = 'Downton Abbey S03E01 1080p DSNP WEB-DL AAC2 0 H 264-playWEB.mkv';
    const subsro = 'Downton Abbey - S3E1 Episode One.ro [Downton.Abbey.S03.1080p.DSNP.WEB-DL.AAC2.0.H.264-playWEB]';
    check('the release in brackets is the file\'s group: trusted, served directly', fromFileGroup(PLAYWEB, subsro));
    const ranked = rankSubtitles([
      item('Downton.Abbey.S03E01.Episode.1.1080p.SKST.WEB-DL.AAC2.0.x264-VELUN.ro-RO'),
      item(subsro),
      item('Downton Abbey - S3E2 Episode Two.ro [Downton.Abbey.S03.1080p.DSNP.WEB-DL.AAC2.0.H.264-playWEB]')
    ], { filename: PLAYWEB, season: 3, episode: 1 });
    const top = ranked.details[0];
    check('the score counts the group in brackets', top.release === subsro && top.reasons.some(r => /group/.test(r)), top);
    check('a release in brackets never lets another episode through', ranked.details.find(d => /S3E2/.test(d.release))?.rejected === true, ranked.details.map(d => [d.release.slice(0, 30), d.rejected]));
  }

  console.log('Independent references (Downton Abbey)');
  {
    const REMUX = 'Downton.Abbey.S03E01.1080p.BluRay.REMUX.AVC.FLAC.2.0-FraMeSToR.mkv';
    const found = [
      item('Downton.Abbey.Season3.1080p.BluRay.x264-SHORTBREHD', 'subdl', 'per'),
      item('Downton.Abbey.S03.1080p.BluRay.x264-SHORTBREHD', 'subdl', 'ara'),
      item('Downton.Abbey.S03.1080p.BluRay.HEVC.x265.10bit.AAC.2.0-Joy', 'subsource', 'per')
    ];
    const picked = pickReferenceCandidates(found, REMUX, 3, 1).map(i => i.release);
    check('different releases first: SHORTBREHD, Joy, then the second SHORTBREHD', picked[1]?.includes('Joy') && picked.length === 3, picked);

    // the file's timeline is TRUTH; SHORTBREHD (the subtitle and two references) is 2.2 s early on it
    const ref = (cues: Array<{ start: number; end: number }>, label: string) => ({ label, lang: 'x', provider: 'x', cues: cues.map(c => ({ ...c, speech: true })) });
    const early = BASE.map(c => ({ start: c.start - 2.2, end: c.end - 2.2 }));
    const refs = [
      ref(early, '[per] Downton.Abbey.Season3.1080p.BluRay.x264-SHORTBREHD'),
      ref(early.filter((_, i) => i % 5 !== 1), '[ara] Downton.Abbey.S03.1080p.BluRay.x264-SHORTBREHD'),
      ref(BASE.filter((_, i) => i % 12 !== 2), '[per] Downton.Abbey.S03.1080p.BluRay.HEVC.x265.10bit.AAC.2.0-Joy')
    ];
    const candidate = toSrt(early, 0, 'romana');
    const before = alignAgainst(candidate, refs);
    check('BEFORE: without knowing the subtitle\'s release, its own references "confirm" it', before.decision.reason === 'already aligned', before.decision);
    const after = alignAgainst(candidate, refs, 'Downton.Abbey.S03E01.1080p.BluRay.x264-SHORTBREHD');
    check('AFTER: its own release is left out, the independent reference moves it +2.2 s', after.decision.apply && Math.abs(after.decision.offset - 2.2) < 0.15 && /left out/.test(after.note || ''), { d: after.decision, note: after.note });
    const none = alignAgainst(candidate, refs.slice(0, 2), 'Downton.Abbey.S03E01.1080p.BluRay.x264-SHORTBREHD');
    check('only references of its own release: "no independent reference", nothing changed', !none.decision.apply && none.decision.reason === 'no independent reference', none.decision);
  }

  console.log('The file\'s own release decides (Gone Baby Gone)');
  {
    const FILE = 'Gone.Baby.Gone.2007.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-EPSiLON [REMUX-CLUB].mkv';
    const ref = (cues: Array<{ start: number; end: number }>, label: string) => ({ label, lang: 'x', provider: 'x', cues: cues.map(c => ({ ...c, speech: true })) });
    const shift = (d: number) => BASE.map(c => ({ start: c.start + d, end: c.end + d }));
    // the file's timeline is BASE; the TiMELORDS subtitle is 7.9 s late on it; a FraMeSToR release is 5.6 s late
    const candidate = toSrt(shift(7.9), 0, 'romana');
    const refs = [
      ref(BASE.filter((_, i) => i % 5 !== 1), '[zh-CN] Gone.Baby.Gone.2007.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-EPSiLON'),
      ref(shift(5.6).filter((_, i) => i % 7 !== 3), '[pt-PT] Gone.Baby.Gone.2007.BluRay.1080p.DTS-HD.MA.5.1.AVC.HYBRID.REMUX-FraMeSToR')
    ];
    const before = alignAgainst(candidate, refs, 'Gone.Baby.Gone.2006.1080p.BluRay.x264-TiMELORDS');
    check('BEFORE: two releases that disagree -> nothing done', !before.decision.apply && /disagree/.test(before.decision.reason), before.decision);
    const after = alignAgainst(candidate, refs, 'Gone.Baby.Gone.2006.1080p.BluRay.x264-TiMELORDS', FILE);
    check('AFTER: the reference made for the file\'s own release (EPSiLON) moves it -7.9 s', after.decision.apply && Math.abs(after.decision.offset + 7.9) < 0.15 && /file's own release \(epsilon/.test(after.note || ''), { d: after.decision, note: after.note });
    const unrelated = alignAgainst(candidate, [refs[1]], 'Gone.Baby.Gone.2006.1080p.BluRay.x264-TiMELORDS', FILE);
    check('without a reference of the file\'s release, the usual rules apply', !/file's own release/.test(unrelated.note || ''), unrelated);
    const ownSub = alignAgainst(toSrt(BASE, 0, 'x'), refs, 'Gone.Baby.Gone.2007.1080p.BluRay.REMUX-EPSiLON', FILE);
    check('a subtitle of the file\'s own group is never "confirmed" by its own release', /left out/.test(ownSub.note || '') && !/file's own release \(epsilon/.test(ownSub.note || ''), ownSub);
  }

  console.log('References agree');
  {
    const ref = (cues: Array<{ start: number; end: number }>, label: string) => ({ label, lang: 'eng', provider: 'x', cues: cues.map(c => ({ ...c, speech: true })) });
    const same = BASE.filter((_, i) => i % 6 !== 2).map(c => ({ start: c.start + 0.08, end: c.end + 0.05 }));
    check('two references of one timeline agree', referencesAgree([ref(BASE, 'a'), ref(same, 'b')]));
    check('two references of different timelines do not (no alternative is tried then)', !referencesAgree([ref(BASE, 'a'), ref(makeBase(99, 320), 'b')]));
    check('one reference alone is not enough', !referencesAgree([ref(BASE, 'a')]));
  }

  // ============ the whole thing, with a faked network ============
  console.log('End to end');
  const TRUTH = BASE;                         // timeline of the playing 2160p file (what the references have)
  const LATE = 5;                             // the HD-based Romanian subtitle is 5 s late
  const REF_FIN = toSrt(TRUTH, 0.05, 'finnish');
  const REF_ARA = toSrt(TRUTH.filter((_, i) => i % 7 !== 3), -0.05, 'arabic');
  const RO_HD = toSrt(TRUTH, LATE, 'romana');
  const RO_OTHER = toSrt(makeBase(99, 320), 0, 'alta');   // made for a release with a completely different timeline

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
    if (url.includes('/ro-other')) return body(RO_OTHER);
    if (url.includes('/ro-empty')) return body('1\n00:00:01,000 --> 00:00:02,000\nshort\n');
    if (url.includes('/rate-limited')) throw Object.assign(new Error('Request failed with status code 469'), { response: { status: 469 } });
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

    // The Chaser case: same kind (HD web) but another group -> the label is not trusted, the link is checked
    globalSubtitleCache.clear?.();
    const sameKind = parseSubtitleQuery('series', 'tt13146488:1:1', { filename: 'Peacemaker.S01E01.1080p.HMAX.WEB-DL.H.264-OTHER.mkv' });
    const list3 = await getAggregatedSubtitles(sameKind, stored, baseUrl, uuid);
    check('same kind, other group: the link is wrapped (checked against references)', list3.subtitles.length === 1 && list3.subtitles[0].url.includes('/sub/aligned/'), list3.subtitles.map(s => s.url));

    globalSubtitleCache.clear?.();
    const off = await getAggregatedSubtitles(q, { ...stored, subsync: false }, baseUrl, uuid);
    check('switched off in the configuration: links are left alone', off.subtitles.every(s => !s.url.includes('/sub/aligned/')));

    globalSubtitleCache.clear?.();
    const noName = await getAggregatedSubtitles(parseSubtitleQuery('series', 'tt13146488:1:1', {}), stored, baseUrl, uuid);
    check('no file name from the player: links are left alone', noName.subtitles.every(s => !s.url.includes('/sub/aligned/')));

    // how long the list may be kept: normal 30 min; a provider failing or nothing found -> 2 min only
    check('a complete list is kept 30 min', noName.cacheMaxAge === 1800, noName.cacheMaxAge);
    globalSubtitleCache.clear?.();
    const working = (OpenSubtitlesProvider.prototype as any).executeSearch;
    (OpenSubtitlesProvider.prototype as any).executeSearch = async () => { throw new Error('simulated outage'); };
    const partial = await getAggregatedSubtitles(parseSubtitleQuery('series', 'tt13146488:1:1', {}), stored, baseUrl, uuid);
    (OpenSubtitlesProvider.prototype as any).executeSearch = working;
    check('a provider failing: the list is kept 2 min only', partial.cacheMaxAge === 120, partial.cacheMaxAge);
    const again = await getAggregatedSubtitles(parseSubtitleQuery('series', 'tt13146488:1:1', {}), stored, baseUrl, uuid);
    check('...and on the server too: still within those 2 min, the answer stays short-lived', again.cacheMaxAge === 120, again.cacheMaxAge);
    globalSubtitleCache.clear?.();
    const nothing = await getAggregatedSubtitles(parseSubtitleQuery('series', 'tt0000001:1:1', {}), mergeWithDefaults({ ...stored, languages: ['kor'] }), baseUrl, uuid);
    check('nothing in the chosen languages: kept 2 min only', nothing.subtitles.length === 0 && nothing.cacheMaxAge === 120, nothing.cacheMaxAge);

    // several Romanian subtitles: each link carries the ones after it (same language) as alternatives
    globalSubtitleCache.clear?.();
    providerItems.push(
      { id: 'ro-ntb', provider: 'subdl', providerName: 'SubDL', url: baseUrl + '/ro-hd?ntb', lang: 'ron', release: 'Peacemaker.2022.S01E01.720p.HMAX.WEB-DL.DD5.1.H.264-NTb' },
      { id: 'en-ntb', provider: 'subdl', providerName: 'SubDL', url: baseUrl + '/en-hd', lang: 'eng', release: 'Peacemaker.2022.S01E01.720p.HMAX.WEB-DL.DD5.1.H.264-NTb' }
    );
    const multi = await getAggregatedSubtitles(q, mergeWithDefaults({ ...stored, languages: ['ron', 'eng'] }), baseUrl, uuid);
    const tokens = multi.subtitles.map(s => decodeAlignedToken((s.url.split('/sub/aligned/')[1] || '').replace('.srt', '')));
    const firstRo = tokens.find(t => t && t.u === baseUrl + '/ro-hd');
    check('the first Romanian link carries the next Romanian subtitle as an alternative (and not the English one)',
      firstRo?.a?.length === 1 && firstRo.a[0].u === baseUrl + '/ro-hd?ntb', tokens);
    providerItems.splice(providerItems.findIndex(i => i.id === 'ro-ntb'), 2);
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
    // (the list above already started aligning its first subtitle: start from nothing here)
    await new Promise(r2 => setTimeout(r2, 300));
    clearAlignmentDecisions();
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
    const log = (await getAlignments(uuid))[0];
    check('the decision is recorded for the Debug page', log?.outcome === 'shifted' && Math.abs(log.offset - -5) < 0.2 && log.references.length === 2, log);
    check('an all-language search was made once', providerCalls === 1, providerCalls);

    const again = respond();
    const callsBefore = providerCalls;
    await handler({ params: { config: uuid, data: linkFor(baseUrl + '/ro-hd') }, query: {} } as any, again.res);
    check('the second request is served from the cache (no new search)', providerCalls === callsBefore && again.out.body === r.out.body);
    check('the decision is logged once, not once per request', (await getAlignments(uuid)).length === 1, (await getAlignments(uuid)).length);
  }

  {
    // verified candidate: the first subtitle fits no reference, the references agree -> the first alternative that fits is served
    const withAlts = (u: string, alts: Array<{ u: string; r?: string }>) =>
      Buffer.from(JSON.stringify({ u, id: 'tt13146488:1:1', t: 'series', f: CRU, r: 'Peacemaker.S01E01.OTHER-RELEASE', a: alts })).toString('base64url');
    const r = respond();
    await handler({ params: { config: uuid, data: withAlts(baseUrl + '/ro-other', [
      { u: 'https://169.254.169.254/x', r: 'not allowed' },
      { u: baseUrl + '/ro-other?2', r: 'also wrong' },
      { u: baseUrl + '/ro-hd?alt=1', r: 'Peacemaker.2022.S01E01.1080p.HMAX.WEB-DL.DD5.1.H.264-FLUX' }
    ]) }, query: {} } as any, r.res);
    const served = parseCues(r.out.body);
    check('a subtitle that fits no reference is replaced by the first alternative that does', r.out.body.includes('romana 10') && !r.out.body.includes('alta'), r.out.body.slice(0, 80));
    check('and the alternative is re-timed too', Math.abs(served[10].start - TRUTH[10].start) < 0.2, served[10]);
    const log = (await getAlignments(uuid))[0];
    check('Debug notes the replacement', log?.replacedBy === 'Peacemaker.2022.S01E01.1080p.HMAX.WEB-DL.DD5.1.H.264-FLUX' && log.outcome === 'shifted', log);
    check('the not-allowed alternative was never fetched', !fetched.some(u => u.includes('169.254.169.254')));

    const none = respond();
    await handler({ params: { config: uuid, data: withAlts(baseUrl + '/ro-other?3', [{ u: baseUrl + '/ro-other?4' }]) }, query: {} } as any, none.res);
    check('no alternative fits: the original is sent unchanged', none.out.body.includes('alta 10') && !(await getAlignments(uuid))[0].replacedBy);

    const fitting = respond();
    const fetchedBefore = fetched.length;
    await handler({ params: { config: uuid, data: withAlts(baseUrl + '/ro-hd?fits=1', [{ u: baseUrl + '/ro-other?5' }]) }, query: {} } as any, fitting.res);
    check('a subtitle that fits is never replaced (alternatives not even downloaded)', fitting.out.body.includes('romana 10') && !fetched.slice(fetchedBefore).some(u => u.includes('ro-other')));
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
    check('the outcome says why', (await getAlignments(uuid))[0].outcome === 'unchanged' && /no reference/.test((await getAlignments(uuid))[0].reason), (await getAlignments(uuid))[0]);
    providerItems.push(...saved);
  }

  {
    // slow search (2.5 s): the player waits and gets the aligned subtitle from the first try
    clearReferenceCache();
    searchDelayMs = 2500;
    const r = respond();
    const t0 = Date.now();
    await handler({ params: { config: uuid, data: linkFor(baseUrl + '/ro-hd?slow=1') }, query: {} } as any, r.res);
    const took = Date.now() - t0;
    check('slow search: the first answer is already aligned (the player waits)', took >= 2400 && Math.abs(parseCues(r.out.body)[10].start - (parseCues(RO_HD)[10].start - 5)) < 0.15, { took, start: parseCues(r.out.body)[10]?.start });
    check('and the aligned answer may be kept by the player', r.out.headers['Cache-Control'] === 'public, max-age=3600', r.out.headers);

    // stuck search (past the safety limit, 4 s in this test): the original, then the next request gets the result
    clearReferenceCache();
    searchDelayMs = 5000;
    const link = linkFor(baseUrl + '/ro-hd?stuck=1');
    const s1 = respond();
    const t1 = Date.now();
    await handler({ params: { config: uuid, data: link }, query: {} } as any, s1.res);
    const took1 = Date.now() - t1;
    check('past the safety limit: answered with the original', took1 < 4600 && Math.abs(parseCues(s1.out.body)[10].start - parseCues(RO_HD)[10].start) < 0.002, took1);
    check('not cached by the player', s1.out.headers['Cache-Control'] === 'no-store', s1.out.headers);
    check('the outcome is "timeout"', (await getAlignments(uuid))[0].outcome === 'timeout');
    await new Promise(r2 => setTimeout(r2, 1500));
    const next = respond();
    await handler({ params: { config: uuid, data: link }, query: {} } as any, next.res);
    check('the next request finds it aligned', Math.abs(parseCues(next.out.body)[10].start - (parseCues(RO_HD)[10].start - 5)) < 0.15, parseCues(next.out.body)[10].start);
    searchDelayMs = 0;
  }

  {
    // the list starts the alignment of the first subtitle at once: the player's request then finds it under way
    clearAlignmentDecisions();
    clearReferenceCache();
    globalSubtitleCache.clear?.();
    providerCalls = 0;
    searchDelayMs = 800;
    const q = parseSubtitleQuery('series', 'tt13146488:1:1', { filename: CRU });
    const list = await getAggregatedSubtitles(q, stored, baseUrl, uuid);
    const wrapped = list.subtitles.find(s => s.url.includes('/sub/aligned/'))!;
    await new Promise(r2 => setTimeout(r2, 1500));
    const callsAfterList = providerCalls;
    const r = respond();
    const t0 = Date.now();
    await handler({ params: { config: uuid, data: wrapped.url.split('/sub/aligned/')[1].replace('.srt', '') }, query: {} } as any, r.res);
    check('prepared in advance: the player gets the aligned subtitle without waiting for a search', Date.now() - t0 < 500 && providerCalls === callsAfterList && Math.abs(parseCues(r.out.body)[10].start - (parseCues(RO_HD)[10].start - 5)) < 0.15, { ms: Date.now() - t0, calls: providerCalls - callsAfterList });
    searchDelayMs = 0;
  }

  {
    // backup sources: the first link answers "rate limited", the next one works
    clearAlignmentDecisions();
    const withBackup = Buffer.from(JSON.stringify({ u: baseUrl + '/rate-limited/1', b: [baseUrl + '/ro-hd?backup=1'], id: 'tt13146488:1:1', t: 'series', f: CRU, r: 'X' })).toString('base64url');
    const r = respond();
    await handler({ params: { config: uuid, data: withBackup }, query: {} } as any, r.res);
    check('aligned link: the first source fails, the backup is downloaded and aligned', r.out.status === 200 && Math.abs(parseCues(r.out.body)[10].start - (parseCues(RO_HD)[10].start - 5)) < 0.15, { status: r.out.status, body: r.out.body.slice(0, 60) });

    const fallback = createFallbackHandler(() => baseUrl);
    const f1 = respond();
    await fallback({ params: { config: uuid, data: Buffer.from(JSON.stringify({ u: baseUrl + '/rate-limited/2', b: ['https://169.254.169.254/x', baseUrl + '/ro-other?backup=2'] })).toString('base64url') }, query: {} } as any, f1.res);
    check('fallback link: the backup is served as it is (not-allowed hosts are skipped)', f1.out.status === 200 && f1.out.body.includes('alta 10') && !fetched.some(u => u.includes('169.254.169.254')), f1.out.status);
    const f2 = respond();
    await fallback({ params: { config: uuid, data: Buffer.from(JSON.stringify({ u: baseUrl + '/rate-limited/3', b: [baseUrl + '/rate-limited/4'] })).toString('base64url') }, query: {} } as any, f2.res);
    check('fallback link: every source fails -> an error, not a broken file', f2.out.status === 502, f2.out.status);
    const f3 = respond();
    await fallback({ params: { config: uuid, data: Buffer.from(JSON.stringify({ u: 'https://169.254.169.254/x', b: [] })).toString('base64url') }, query: {} } as any, f3.res);
    check('fallback link: a main link to any other host is refused', f3.out.status === 400, f3.out.status);
  }

  {
    // the list: a subtitle found by two providers carries the second one as a backup
    clearAlignmentDecisions();
    globalSubtitleCache.clear?.();
    const dup: RawSubtitleItem = { id: 'ro-dup', provider: 'opensubtitles', providerName: 'OpenSubtitles', url: baseUrl + '/ro-hd?dup=1', lang: 'ron', release: 'Peacemaker.2022.S01E01.1080p.HMAX.WEB-DL.DD5.1.H.264-FLUX' };
    providerItems.push(dup);
    const sameGroupFile = parseSubtitleQuery('series', 'tt13146488:1:1', { filename: 'Peacemaker.S01E01.1080p.HMAX.WEB-DL.H.264-FLUX.mkv' });
    const list = await getAggregatedSubtitles(sameGroupFile, stored, baseUrl, uuid);
    const fb = list.subtitles.find(x => x.url.includes('/sub/fallback/'));
    const tok = fb ? decodeFallbackToken(fb.url.split('/sub/fallback/')[1].replace('.srt', '')) : null;
    check('a duplicate becomes a backup: the link goes through the fallback endpoint', list.subtitles.filter(x => x.lang === 'ron').length === list.subtitles.filter(x => x.lang === 'ron' && !x.url.includes('?dup=1')).length && Boolean(tok && tok.b.length === 1), list.subtitles.map(x => x.url.slice(0, 70)));
    providerItems.splice(providerItems.indexOf(dup), 1);
  }

  {
    // the list: a copy from a source refusing this server gives its place to a working backup,
    // and a subtitle that cannot be downloaded at all goes after the ones that can be checked
    clearAlignmentDecisions();
    globalSubtitleCache.clear?.();
    noteRefusal('blocked.example', 469, 'too many');
    const saved = providerItems.splice(0, providerItems.length);
    providerItems.push(
      { id: 'ro-blocked', provider: 'opensubtitles', providerName: 'OS', url: 'https://blocked.example/a.srt', lang: 'ron', release: 'Peacemaker.2022.S01E01.1080p.HMAX.WEB-DL.DD5.1.H.264-AAA' },
      { id: 'ro-blocked-copy', provider: 'opensubtitles', providerName: 'OS', url: baseUrl + '/ro-hd?copy=1', lang: 'ron', release: 'Peacemaker.2022.S01E01.1080p.HMAX.WEB-DL.DD5.1.H.264-AAA' },
      { id: 'ro-only-blocked', provider: 'opensubtitles', providerName: 'OS', url: 'https://blocked.example/b.srt', lang: 'ron', release: 'Peacemaker.S01E01.2160p.PL.HMAX.WEB-DL.DDPA5.1.HDR.DV.HEVC-XYZ' },
      { id: 'ro-ok', provider: 'opensubtitles', providerName: 'OS', url: baseUrl + '/ro-other?ok=1', lang: 'ron', release: 'Peacemaker.2022.S01E01.720p.WEBRip.x264-ION10' }
    );
    const list = await getAggregatedSubtitles(parseSubtitleQuery('series', 'tt13146488:1:1', { filename: CRU }), { ...stored, addons: stored.addons, customAddons: [{ url: 'https://blocked.example/manifest.json' } as any] }, baseUrl, uuid);
    const inner = list.subtitles.map(x => {
      const t = x.url.includes('/sub/aligned/') ? decodeAlignedToken(x.url.split('/sub/aligned/')[1].replace('.srt', '')) : null;
      return t ? t.u : x.url;
    });
    check('the working copy is the one kept (the refusing one becomes its backup)', inner.includes(baseUrl + '/ro-hd?copy=1') && !inner.includes('https://blocked.example/a.srt'), inner);
    check('the subtitle only available from a refusing source goes last', inner[inner.length - 1] === 'https://blocked.example/b.srt', inner);
    providerItems.splice(0, providerItems.length, ...saved);
    clearSourceHealth();
  }

  {
    // Downton Abbey S03E03: an exact hash match from OpenSubtitles direct, while its quota is reached
    const OS_URL = '/proxy/download/os-rest/1541522?apiKey=k';
    const PRO_URL = baseUrl + '/ro-hd?pro=1';
    const SHORT = 'Downton.Abbey.S03E03.1080p.BluRay.x264-SHORTBREHD.mkv';
    const saved = providerItems.splice(0, providerItems.length);
    providerItems.push(
      { id: 'os-hash', provider: 'opensubtitles', providerName: 'OS', url: OS_URL, lang: 'ron', release: 'downton.abbey.s03e03.720p.bluray.x264-shortbrehd', hashMatch: true },
      { id: 'pro-copy', provider: 'community.opensubtitlesv3.pro', providerName: 'PRO', url: PRO_URL, lang: 'ron', release: 'downton.abbey.s03e03.720p.bluray.x264-shortbrehd' },
      { id: 'os-dead', provider: 'opensubtitles', providerName: 'OS', url: '/proxy/download/os-rest/999?apiKey=k', lang: 'ron', release: 'Downton.Abbey.S03E03.1080p.BluRay.x264-SHORTBREHD.Retail', hashMatch: true }
    );
    const q3 = parseSubtitleQuery('series', 'tt1606375:3:3', { filename: SHORT });

    // quota not known (just after a restart): the hash match keeps first place but carries its copy as a backup
    clearSourceHealth();
    globalSubtitleCache.clear?.();
    const before = await getAggregatedSubtitles(q3, stored, baseUrl, uuid);
    const first = before.subtitles[0];
    const fb = first.url.includes('/sub/fallback/') ? decodeFallbackToken(first.url.split('/sub/fallback/')[1].replace('.srt', '')) : null;
    check('a hash match carries its copies as backups (served through the fallback link)', Boolean(fb && fb.u === baseUrl + OS_URL && fb.b.includes(PRO_URL)), before.subtitles.map(x => x.url.slice(0, 80)));

    // quota known: the working copy takes the place of the hash match (still a hash match), the one with no copy goes last
    noteRefusal('api.opensubtitles.com', 406, 'quota');
    noteRefusal('dl.opensubtitles.org', 403, 'blocked');
    noteRefusal('subs5.strem.io', 469, 'too many');
    globalSubtitleCache.clear?.();
    const after = await getAggregatedSubtitles({ ...q3 }, { ...stored, subsync: false }, baseUrl, uuid);
    const urls = after.subtitles.map(x => x.url);
    const firstAfter = urls[0].includes('/sub/fallback/') ? decodeFallbackToken(urls[0].split('/sub/fallback/')[1].replace('.srt', ''))!.u : urls[0];
    check('quota reached: the copy that works is served first', firstAfter === PRO_URL, urls.map(u => u.slice(0, 80)));
    check('a subtitle nobody can download goes last, even with Subsync off', urls[urls.length - 1] === baseUrl + '/proxy/download/os-rest/999?apiKey=k', urls.map(u => u.slice(0, 80)));

    // remembered across a restart through the store
    const savedBlocks: string[] = [];
    attachRefusalStore({ save: (src) => { savedBlocks.push(src); } });
    noteRefusal('example.host', 469, 'x');
    attachRefusalStore(null);
    clearSourceHealth();
    restoreRefusals([{ source: 'api.opensubtitles.com', until: Date.now() + 60000, reason: 'quota' }, { source: 'old.host', until: Date.now() - 1, reason: 'old' }]);
    check('refusals are saved to the store and read back at start (expired ones ignored)', savedBlocks.includes('example.host') && isBlocked('api.opensubtitles.com') && !isBlocked('old.host'));
    clearSourceHealth();
    providerItems.splice(0, providerItems.length, ...saved);
    globalSubtitleCache.clear?.();
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
  await stopAlignWorker();
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
