import { parseRelease, rankSubtitles, looksForced, looksMachineTranslated, setDefaultRules, titlesMatch, exactNameMatch } from '../src/utils/scorer';
import { computeRuleImpact } from '../src/utils/ruleImpact';
import { RawSubtitleItem } from '../src/types/provider';

// "scorer.test.ts all" (or SCORER_RULES=all) runs the whole suite with every optional rule switched on (regression check for those rules)
if (process.env.SCORER_RULES === 'all' || process.argv[2] === 'all') {
  setDefaultRules({ fuzzyGroup: true, sourceTiers: true, multiVariant: true, exactTier: true });
  console.log('(all optional scoring rules ON)');
}

let failed = 0;
function check(label: string, ok: boolean, info?: unknown): void {
  if (!ok) {
    failed++;
    console.error('FAIL', label, info !== undefined ? JSON.stringify(info) : '');
  }
}

function item(release: string, provider = 'subdl', extra: Partial<RawSubtitleItem> = {}): RawSubtitleItem {
  return { id: provider + ':' + release, provider, providerName: provider, url: '/x', lang: 'ron', release, ...extra };
}

// ---------- parsing ----------
const p1 = parseRelease('Guardians.of.the.Galaxy.Vol.3.2023.1080p.BluRay.x264-ROEN 2;30;02');
check('group ROEN with trailing runtime', p1.group === 'roen', p1);
check('year/res/source', p1.year === 2023 && p1.resolution === 1080 && p1.source === 'bluray', p1);

const p2 = parseRelease('Obsession.2026.1080p.AMZN.WEB-DL.DDP5.1.H.264-KyoGo.is');
check('group with language suffix', p2.group === 'kyogo', p2);
check('service AMZN + webdl', p2.service === 'amzn' && p2.source === 'webdl', p2);

check('no group on plain WEB-DL', parseRelease('Spider-Man.Far.from.Home.2019.WEB-DL.DSNP').group === null);
check('DTS-HD is not a group', parseRelease('Movie.2019.1080p.BluRay.DTS-HD.MA.5.1.x264').group === null);
check('AC-3 is not a group', parseRelease('Movie.2019.HDTS.720p.x264.AC-3').group === null);

const pRemux = parseRelease('Obsession.2025.UHD.BluRay.2160p.TrueHD.Atmos.7.1.DV.HEVC.REMUX-FraMeSToR.mkv');
check('remux file', pRemux.source === 'remux' && pRemux.resolution === 2160 && pRemux.group === 'framestor', pRemux);
check('title tokens', pRemux.titleTokens.join(' ') === 'obsession', pRemux);

const pcam = parseRelease('Guardians.of.the.Galaxy.Vol.3.2023.2160p.CAM.NEW.AUDIO.HC.SUBS.X264.Will1869');
check('cam is bad quality', pcam.badQuality, pcam);
check('HDTC is bad quality', parseRelease('Guardians.Of.The.Galaxy.Volume.3.2023.1080p.Trial.HDTC.x264.AC-3.YG').badQuality);

const pHone = parseRelease('Slow Horses (2022) S01E01 (2160p ATVP WEB-DL Hybrid H265 DV HDR10  DDP Atmos 5.1 English - HONE).mkv');
check('group inside parentheses', pHone.group === 'hone', pHone);
check('parenthesised name still parses episode/service', pHone.season === 1 && pHone.episode === 1 && pHone.service === 'atvp', pHone);
check('Movie (2019) has no group', parseRelease('Movie (2019)').group === null);

const pep = parseRelease('Friends.S03E09.1080p.BluRay.x264-GRP.mkv');
check('season/episode', pep.season === 3 && pep.episode === 9, pep);

// ---------- movie WITH file name (REMUX FraMeSToR) ----------
{
  const items = [
    item('Obsession.2025.1080p.AMZN.WEB-DL.DDP5.1.H.264-KyoGo'),
    item('Obsession 2025 1080p MA WEB-DL DDP5 1 Atmos H 264-BYNDR'),
    item('Obsession.2026.720p.VOSTFR.HDTS.x264-FS.ro'),
    item('Obsession.2025.1080p.BluRay.H264-RiSEHD'),
    item('Obsession'),
    item('Obsession.2025.2160p.UHD.Blu-ray.Remux.DV.HDR.HEVC.TrueHD.Atmos.7.1-CiNEPHiLES'),
    item('Obsession.2025.1080p.BluRay.REMUX.AVC-FraMeSToR')
  ];
  const r = rankSubtitles(items, { filename: 'Obsession.2025.UHD.BluRay.2160p.TrueHD.Atmos.7.1.DV.HEVC.REMUX-FraMeSToR.mkv' });
  const order = r.items.map(i => i.release);
  check('a 2160p REMUX file gets the 2160p REMUX subtitle first (same resolution class)', order[0] === 'Obsession.2025.2160p.UHD.Blu-ray.Remux.DV.HDR.HEVC.TrueHD.Atmos.7.1-CiNEPHiLES', order);
  check('the HD remux with the same group name comes right after', order[1] === 'Obsession.2025.1080p.BluRay.REMUX.AVC-FraMeSToR', order);
  check('HDTS is last', order[order.length - 1] === 'Obsession.2026.720p.VOSTFR.HDTS.x264-FS.ro', order);
  check('nothing dropped (2026 is within 1 year)', r.items.length === items.length, order);
}

// ---------- movie WITHOUT file name: wrong titles dropped, cam last ----------
{
  const items = [
    item('Guardians.Of.The.Galaxy.Volume.3.2023.1080p.Trial.HDTC.x264.AC-3.YG', 'org.stremio.subsro'),
    item('Marvel.Studios.Assembled.S02E02.The.Making.of.Guardians.of.the.Galaxy.Vol.3 [WEB-DL 3 variante]', 'org.stremio.subsro'),
    item('Guardians.of.the.Galaxy.Vol.3.2023.2160p.WEB-DL.DDP5.1.Atmos.HDR.DV.HEVC-CMRG', 'community.opensubtitlesv3.pro'),
    item('Guardians.of.the.Galaxy.Vol.3.2023.1080p.BluRay.x264-ROEN 2;30;02'),
    item('Guardians.of.the.Galaxy.Vol.3.2023.2160p.CAM.NEW.AUDIO.HC.SUBS.X264.Will1869', 'community.opensubtitlesv3.pro'),
    item('Guardians of the Galaxy Vol. 3 (2023)', 'community.opensubtitlesv3.pro'),
    item('Guardians.of.the.Galaxy.Vol.3.2014.1080p.BluRay.x264-OLD')
  ];
  const r = rankSubtitles(items, { filename: null });
  const order = r.items.map(i => i.release);
  check('bonus content (other title) removed', !order.some(o => o.startsWith('Marvel.Studios')), order);
  check('other year removed', !order.some(o => o.includes('.2014.')), order);
  check('good release first', order[0].includes('1080p.BluRay') || order[0].includes('WEB-DL'), order);
  check('CAM/HDTC at the bottom', /CAM|HDTC/.test(order[order.length - 1]) && /CAM|HDTC/.test(order[order.length - 2]), order);
  check('uninformative title kept', order.includes('Guardians of the Galaxy Vol. 3 (2023)'), order);
  check('no filename flagged', r.usedFilename === false);
}

// ---------- series: strict episode filter ----------
{
  const items = [
    item('Friends.S03E08.1080p.BluRay.x264-GRP'),
    item('Friends.S03E09.720p.WEB-DL.x264-XYZ'),
    item('Friends.S03E09.1080p.BluRay.x264-GRP'),
    item('Friends.S04E09.1080p.BluRay.x264-GRP'),
    item('Friends.with.Benefits.2011.720p.BluRay.x264-ABC'),
    item('Friends.S03E19.1080p.BluRay.x264-GRP')
  ];
  const r = rankSubtitles(items, { filename: 'Friends.S03E09.1080p.BluRay.x264-GRP.mkv', season: 3, episode: 9 });
  const order = r.items.map(i => i.release);
  check('exact episode + group first', order[0] === 'Friends.S03E09.1080p.BluRay.x264-GRP', order);
  check('other episodes/seasons/titles dropped', order.length === 2, order);
}

// ---------- UHD vs HD master (Game of Thrones S01E01 case) ----------
{
  const items = [
    item('game.of.thrones.s01e01.1080p.bluray.x264-FraMeSToR', 'org.stremio.subsro'),
    item('Game of Thrones S01E01 Winter is Coming 2160p UHD BluRay TrueHD 7.1 DoVi-DON', 'org.stremio.subsro'),
    item('Game.of.Thrones.S01E01.720p.BluRay.X264-REWARD', 'org.stremio.subsro')
  ];
  const uhd = rankSubtitles(items, {
    filename: 'Game.of.Thrones.S01E01.Winter.Is.Coming.2160p.TrueHD.Atmos.7.1.DV.HEVC.REMUX-FraMeSToR.mkv',
    season: 1,
    episode: 1
  });
  check('UHD file: the UHD subtitle beats an HD subtitle that only shares the group name', uhd.items[0].release.includes('2160p'), uhd.items.map(i => i.release));

  const hd = rankSubtitles(items, {
    filename: 'Game.of.Thrones.S01E01.Winter.Is.Coming.1080p.BluRay.x264-FraMeSToR.mkv',
    season: 1,
    episode: 1
  });
  check('HD file: the same-group HD subtitle still wins', hd.items[0].release.includes('1080p.bluray.x264-FraMeSToR'), hd.items.map(i => i.release));
}

// ---------- provider bonus ----------
{
  const items = [
    item('Movie.2020.1080p.WEB-DL.x264-AAA', 'subdl'),
    item('Movie.2020.1080p.WEB-DL.x264-AAA', 'org.stremio.subsro')
  ];
  const r = rankSubtitles(items, { filename: null, providerBonus: { subsro: 8 } });
  check('provider bonus applies', r.items[0].provider === 'org.stremio.subsro', r.items.map(i => i.provider));
}

// ---------- safety fallback: never return an empty list ----------
{
  const items = [item('Show.Name.S01E05.1080p.BluRay.x264-AAA'), item('Show.Name.S01E06.720p.WEB-DL.x264-BBB')];
  const r = rankSubtitles(items, { filename: 'Show.Name.S01E01.mkv', season: 1, episode: 1 });
  check('fallback keeps the list when everything is rejected', r.items.length === 2 && r.fallback === true, r);
}

// ---------- exact file hash beats everything ----------
{
  const items = [
    item('Movie.2020.1080p.BluRay.x264-AAA'),
    item('Movie.2020.480p.HDTV.x264-ZZZ', 'opensubtitles', { hashMatch: true })
  ];
  const r = rankSubtitles(items, { filename: 'Movie.2020.1080p.BluRay.x264-AAA.mkv' });
  check('hash match ranks first', r.items[0].provider === 'opensubtitles', r.items.map(i => i.provider));
}

// ---------- an exact name match is in the hash match's tier; the user's priority decides (Homecoming) ----------
{
  const priority = ['subsro', 'regielive', 'opensubtitles'];
  const ctx = (ep: number, title: string) => ({
    filename: `Homecoming.S01E0${ep}.${title}.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb.mkv`, season: 1, episode: ep, providerPriority: priority
  });
  // E01: OpenSubtitles hash match (720p NTb) and Subs.ro 1080p NTb -> Subs.ro first (priority)
  let r = rankSubtitles([
    item('Homecoming.S01E01.Mandatory.720p.AMZN.WEB-DL.DDP5.1.H.264-NTb', 'opensubtitles', { hashMatch: true }),
    item('Homecoming.S01E01.Mandatory.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb', 'subsro'),
    item('Homecoming.S01E01.1080p.WEB.H264-iNSiDiOUS', 'regielive')
  ], ctx(1, 'Mandatory'));
  check('Homecoming E01: Subs.ro exact name first', r.items[0].provider === 'subsro' && r.items[1].provider === 'opensubtitles', r.items.map(i => i.release));
  check('exact name match noted', r.details[0].reasons.some(x => x.startsWith('EXACT NAME MATCH')), r.details[0]);
  // E03: hash match named XviD-AFG, Subs.ro NTb -> Subs.ro first; the hash match still beats a non-exact name
  r = rankSubtitles([
    item('Homecoming.S01E03.1080p.WEB.H264-iNSiDiOUS', 'subsro'),
    item('Homecoming.S01E03.XviD-AFG', 'opensubtitles', { hashMatch: true }),
    item('Homecoming.S01E03.Redwood.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb', 'subsro')
  ], ctx(3, 'Redwood'));
  check('Homecoming E03: exact name, then hash match, then the rest',
    r.items.map(i => i.release).join('|') === 'Homecoming.S01E03.Redwood.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb|Homecoming.S01E03.XviD-AFG|Homecoming.S01E03.1080p.WEB.H264-iNSiDiOUS',
    r.items.map(i => i.release));
  // the priority, not the provider order of the list, decides
  r = rankSubtitles([
    item('Homecoming.S01E04.Redwood.720p.AMZN.WEB-DL.DDP5.1.H.264-NTb', 'opensubtitles', { hashMatch: true }),
    item('Homecoming.S01E04.Redwood.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb', 'regielive')
  ], { ...ctx(4, 'Redwood'), providerPriority: ['regielive', 'opensubtitles'] });
  check('priority decides inside the top tier', r.items[0].provider === 'regielive', r.items.map(i => i.provider));
  // not exact: other service, other episode, other group, a disc of the other resolution class
  const f = 'Homecoming.S01E01.Mandatory.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb.mkv';
  const se = { season: 1, episode: 1 };
  check('2160p WEB of the same release is exact', exactNameMatch('Homecoming.S01E01.2160p.AMZN.WEB-DL.DDP5.1.H.265-NTb', f, se));
  check('other service is not exact', !exactNameMatch('Homecoming.S01E01.1080p.NF.WEB-DL.DDP5.1.H.264-NTb', f, se));
  check('other episode is not exact', !exactNameMatch('Homecoming.S01E02.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb', f, se));
  check('other group is not exact', !exactNameMatch('Homecoming.S01E01.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTG', f, se));
  check('WEBRip is not WEB-DL', !exactNameMatch('Homecoming.S01E01.1080p.AMZN.WEBRip.DDP5.1.x264-NTb', f, se));
  check('bracketed release with the episode outside counts',
    exactNameMatch('Homecoming - S1E1.ro [Homecoming.S01.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb]', f, se));
  const disc = 'Movie.2019.1080p.BluRay.x264-SPARKS.mkv';
  check('720p BluRay of the same group is exact (same HD disc)', exactNameMatch('Movie.2019.720p.BluRay.x264-SPARKS', disc));
  check('UHD BluRay is not the HD disc', !exactNameMatch('Movie.2019.2160p.BluRay.x265-SPARKS', disc));
  check('other edition is not exact', !exactNameMatch('Movie.2019.Extended.1080p.BluRay.x264-SPARKS', disc));
}

// ---------- a resolution glued to the title ("amb-friends720p") ----------
{
  check('glued resolution is split off the title', parseRelease('amb-friends720p').titleTokens.join(' ') === 'amb friends' && parseRelease('amb-friends720p').resolution === 720, parseRelease('amb-friends720p'));
  check('...and is not taken as the group', parseRelease('amb-friends720p').group === null);
  check('glued after the resolution too', parseRelease('Friends.S03E08.1080pBluRay').resolution === 1080 && parseRelease('Friends.S03E08.1080pBluRay').source === 'bluray');
  const r = rankSubtitles([item('amb-friends720p'), item('Other.Show.S03E08.720p.HDTV-XYZ')],
    { filename: 'Friends.S03E08.1080p.BluRay.x264-PSYCHD.mkv', season: 3, episode: 8 });
  check('"amb-friends720p" is kept for Friends (not "another title")', r.items.some(i => i.release === 'amb-friends720p'), r.details);
  check('words with digits are not split ("Se7en", "x264")', parseRelease('Se7en.1995.1080p.BluRay.x264-AMIABLE').titleTokens.join(' ') === 'se7en');
}

// ---------- measuring the rules on stored requests ----------
{
  const stored = [{
    at: '2026-10-02T08:00:00Z', id: 'tt7008682:1:1', filename: 'Homecoming.S01E01.Mandatory.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb.mkv',
    top: [
      { provider: 'opensubtitles', release: 'Homecoming.S01E01.Mandatory.720p.AMZN.WEB-DL.DDP5.1.H.264-NTb', reasons: ['HASH MATCH (exact file)'], rejected: false },
      { provider: 'subsro', release: 'Homecoming.S01E01.Mandatory.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb', reasons: [], rejected: false }
    ]
  }, { at: '2026-10-02T08:00:00Z', id: 'tt1', filename: null, top: [] }];
  const impact = computeRuleImpact(stored, ['subsro', 'opensubtitles']);
  const exact = impact.rules.find(r => r.rule === 'exactTier')!;
  check('rule impact: only requests with a file name are measured', impact.requests === 1, impact);
  check('rule impact: the exact-name tier changes the first pick of Homecoming', exact.changed === 1 && /subsro/.test(exact.examples[0].now) && /opensubtitles/.test(exact.examples[0].flipped), exact);
}

// ---------- forced / machine translated (rule 2) ----------
{
  const video = 'Movie.2021.1080p.BluRay.x264-GRP.mkv';
  const items = [
    // the forced one matches the file perfectly, the full one only partly
    item('Movie.2021.1080p.BluRay.x264-GRP.FORCED'),
    item('Movie.2021.1080p.BluRay.x264-OTHER')
  ];
  const r = rankSubtitles(items, { filename: video });
  check('a forced subtitle never wins against a full one, even with a perfect name match', r.items[0].release === 'Movie.2021.1080p.BluRay.x264-OTHER', r.items.map(i => i.release));

  const flagged = rankSubtitles([
    item('Movie.2021.1080p.BluRay.x264-GRP', 'opensubtitles', { forced: true }),
    item('Movie.2021.1080p.BluRay.x264-OTHER', 'opensubtitles')
  ], { filename: video });
  check('the provider flag (foreign_parts_only) counts too', flagged.items[0].release.endsWith('OTHER'), flagged.items.map(i => i.release));

  const ai = rankSubtitles([
    item('Movie.2021.1080p.BluRay.x264-GRP', 'opensubtitles', { aiTranslated: true }),
    item('Movie.2021.1080p.BluRay.x264-GRP', 'subdl', { id: 'human' })
  ], { filename: video });
  check('a human translation beats an equal machine translation', ai.items[0].provider === 'subdl', ai.items.map(i => i.provider));

  const aiName = rankSubtitles([
    item('Movie.2021.1080p.BluRay.x264-GRP.AI translated'),
    item('Movie.2021.1080p.BluRay.x264-GRP', 'subsro')
  ], { filename: video });
  check('"AI translated" in the name is detected', aiName.items[0].provider === 'subsro', aiName.items.map(i => i.release));

  // not too eager: a full subtitle stays ahead of a worse-matching forced one and both are kept
  const only = rankSubtitles([item('Movie.2021.1080p.BluRay.x264-GRP.forced')], { filename: video });
  check('a lone forced subtitle is still returned (nothing else to offer)', only.items.length === 1);
  check('words that merely contain "forced" letters are not flagged', !looksForced('Reinforced.Concrete.2020.1080p') && !looksForced('Enforced.2020'));
  check('AI is only flagged as a translation term', !looksMachineTranslated('Maid.2021.1080p') && !looksMachineTranslated('Automatic.Weapon.2020'));
}

// ---------- title written longer / with a language prefix (Andor) ----------
{
  const andor = [
    item('Andor.S01E01.1080p.WEB.H264-PECULATE'),
    item('Andor.S01E01.720p.DSNP.WEB-DL.DDP5.1.H.264-NTb'),
    item('Star.Wars.Andor.S01E01.1080p.DSNP.WEB-DL.DDP5.1.H.264-NTb'),
    item('21_Romanian---Andor.S01E01.1080p.DSNP.WEB-DL.DDP5.1.Atmos.H.264-ION10.mp4'),
    item('The.Mandalorian.S01E01.1080p.DSNP.WEB-DL.DDP5.1.H.264-NTb')
  ];
  for (const filename of ['Andor.S01E01.1080p.DSNP.WEB-DL.DDP5.1.H.264-NTb.mkv', 'Star.Wars.Andor.S01E01.1080p.DSNP.WEB-DL.DDP5.1.H.264-NTb.mkv', '']) {
    const r = rankSubtitles(andor, { filename, season: 1, episode: 1 });
    const kept = r.items.map(i => i.release);
    check('Star.Wars.Andor kept (' + (filename || 'no file') + ')', kept.some(n => n.startsWith('Star.Wars.Andor')), r.details);
    check('21_Romanian---Andor kept (' + (filename || 'no file') + ')', kept.some(n => n.startsWith('21_Romanian')), r.details);
    check('another series still rejected (' + (filename || 'no file') + ')', !kept.some(n => n.startsWith('The.Mandalorian')), r.details);
  }
  check('Star.Wars.Andor with the same group ranks first', rankSubtitles(andor, { filename: 'Andor.S01E01.1080p.DSNP.WEB-DL.DDP5.1.H.264-NTb.mkv', season: 1, episode: 1 }).items[0].release.startsWith('Star.Wars.Andor'));

  const tokens = (s: string) => parseRelease(s + '.2003.1080p').titleTokens;
  check('Andor = Star Wars Andor', titlesMatch(tokens('Andor'), tokens('Star Wars Andor')));
  check('Andor = 21 Romanian Andor', titlesMatch(tokens('Andor'), tokens('21 Romanian Andor')));
  check('Wire != Wire in the Blood', !titlesMatch(tokens('The Wire'), tokens('Wire in the Blood')));
  check('a continuation is not an end match', !titlesMatch(tokens('Matrix'), tokens('Matrix Reloaded Revolutions Resurrections')));
  check('leading numbers alone are not skipped', !titlesMatch(tokens('Jump Street'), tokens('21 Jump Street Reunion Special Edition Cut')));
  check('Guardians != Marvel Studios Assembled', !titlesMatch(tokens('Guardians of the Galaxy Vol 3'), parseRelease('Marvel.Studios.Assembled.S02E02.The.Making.of.Guardians.of.the.Galaxy.Vol.3').titleTokens));
  check('at most 3 extra words in front', !titlesMatch(tokens('Andor'), tokens('One Two Three Four Andor')));

  const matrix = rankSubtitles([
    item('The.Matrix.1999.1080p.BluRay.x264-AMIABLE'),
    item('The.Matrix.Reloaded.2003.1080p.BluRay.x264-AMIABLE'),
    item('The.Matrix.1999.720p.BluRay.x264-SiNNERS')
  ], { filename: 'The.Matrix.1999.1080p.BluRay.x264-AMIABLE.mkv' });
  check('Matrix Reloaded still rejected for The Matrix', !matrix.items.some(i => i.release.includes('Reloaded')), matrix.details);

  const jump = rankSubtitles([
    item('21.Jump.Street.2012.1080p.BluRay.x264-SPARKS'),
    item('22.Jump.Street.2014.1080p.BluRay.x264-SPARKS')
  ], { filename: '21.Jump.Street.2012.1080p.BluRay.x264-SPARKS.mkv' });
  check('22 Jump Street still rejected for 21 Jump Street', jump.items.length === 1 && jump.items[0].release.startsWith('21'), jump.details);
}

check('empty input', rankSubtitles([], {}).items.length === 0);

if (failed) {
  console.error(failed + ' scorer check(s) failed');
  process.exit(1);
}
console.log('scorer OK');
