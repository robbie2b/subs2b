import { parseRelease, rankSubtitles } from '../src/utils/scorer';
import { RawSubtitleItem } from '../src/types/provider';

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
  check('same release group wins even at lower resolution', order[0] === 'Obsession.2025.1080p.BluRay.REMUX.AVC-FraMeSToR', order);
  check('remux 2160p second', order[1] === 'Obsession.2025.2160p.UHD.Blu-ray.Remux.DV.HDR.HEVC.TrueHD.Atmos.7.1-CiNEPHiLES', order);
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

check('empty input', rankSubtitles([], {}).items.length === 0);

if (failed) {
  console.error(failed + ' scorer check(s) failed');
  process.exit(1);
}
console.log('scorer OK');
