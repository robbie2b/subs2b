import { subtitleLabel, sourceName, MAX_LABEL_LENGTH } from '../src/utils/subtitleLabel';
import { RawSubtitleItem } from '../src/types/provider';

let failed = 0;
function check(label: string, ok: boolean, info?: unknown): void {
  if (ok) console.log('  ok  ' + label);
  else {
    failed++;
    console.error('FAIL ' + label, info !== undefined ? JSON.stringify(info) : '');
  }
}

const item = (release: string, provider = 'org.stremio.subsro', providerName = 'Subs.ro Subtitles'): RawSubtitleItem =>
  ({ id: 'x', provider, providerName, url: '/x', lang: 'ron', release });

const HP = "Harry.Potter.and.the.Sorcerer's.Stone.2001.Theatrical.Cut.2160p.BluRay.DTS-X.7.1.DV.HDR10.x265-MainFrame.mkv";
const HOME = 'Homecoming.S01E07.Test.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb.mkv';

// ---- the source ----
check('known sources get their short name', sourceName(item('x')) === 'Subs.ro' && sourceName(item('x', 'subtitrarinoi', 'Subtitrari-noi.ro')) === 'Subtitrari-noi'
  && sourceName(item('x', 'community.opensubtitlesv3.pro', 'opensubtitles PRO')) === 'OpenSubtitles PRO' && sourceName(item('x', 'wyzie', 'Wyzie (opensubtitles)')) === 'Wyzie');
check('an imported addon: its name without "Subtitles" and without a bracketed note',
  sourceName(item('x', 'custom-1', 'My Addon Subtitles (beta)')) === 'My Addon');

// ---- the label ----
check('the example of the plan', subtitleLabel(item('Harry.Potter.and.the.Sorcerers.Stone.2001.2160p.BluRay.HEVC.DTS-X.7.1-MainFrame'), { filename: HP, topLevel: true })
  === '★ Subs.ro · 2160p BluRay · MainFrame');
check('service between resolution and source; the group with its own capitals',
  subtitleLabel(item('Homecoming.S01E07.Test.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb'), { filename: HOME }) === 'Subs.ro · 1080p AMZN WEB-DL · NTb');
check('no star unless on the top level', !subtitleLabel(item('Homecoming.S01E07.1080p.WEB.H264-NTb'), { filename: HOME }).startsWith('★'));
check('an old rip is not shown as the disc', subtitleLabel(item('Movie.2001.BRRip.XviD.AC3-Z0N3')) === 'Subs.ro · BRRip XviD · Z0N3');
check('an XviD release without more says so', subtitleLabel(item('Homecoming.S01E07.XviD-AFG')) === 'Subs.ro · XviD · AFG');
check('REMUX', subtitleLabel(item('Movie.2019.2160p.UHD.BluRay.REMUX.HEVC-FraMeSToR'), {}) === 'Subs.ro · 2160p REMUX · FraMeSToR');
check('"-XVID" at the end is the codec, not a group', !/XVID/.test(subtitleLabel(item('Movie.1992.DC.BRRip.XviD.MP3-XVID')).replace('XviD', '')));
check('no group, no source: what is known', subtitleLabel(item('The.Last.of.the.Mohicans.(1992).1080p.BrRip.x264.DTS'), {}) === 'Subs.ro · 1080p BRRip');

// ---- a name listing several releases: the one closest to the file ----
{
  const many = 'Movie.2019.1080p.3D.Blu-ray.AVC-SharpHD; Movie.2019.720p.BRRip.XviD.AC3-EVO; Movie.2019.2160p.BluRay.REMUX.HEVC-FGT';
  const label = subtitleLabel(item(many, 'subtitrarinoi', 'Subtitrari-noi.ro'), { filename: 'Movie.2019.2160p.BluRay.REMUX.HEVC.DTS-HD-FGT.mkv' });
  check('the variant that fits the file explains the label', label === 'Subtitrari-noi · 2160p REMUX · FGT', label);
  check('without a file name the first variant is used', subtitleLabel(item(many, 'subtitrarinoi', 'Subtitrari-noi.ro')) === 'Subtitrari-noi · 1080p BluRay · SharpHD');
}

// ---- nothing readable ----
check('no traits: the start of the name', subtitleLabel(item('Homecoming S01')) === 'Subs.ro · Homecoming S01');
check('the source\'s own placeholder name is not repeated', subtitleLabel(item('OpenSubtitles v3 Subtitle', 'org.stremio.opensubtitlesv3', 'OpenSubtitles v3')) === 'OpenSubtitles v3');
check('no release at all: only the source', subtitleLabel(item('')) === 'Subs.ro');

// ---- the length ----
{
  const long = subtitleLabel(item('Movie.2019.1080p.AMZN.WEB-DL.DDP5.1.H.264-VeryLongGroupName', 'community.opensubtitlesv3.pro', 'opensubtitles PRO'), { filename: HOME, topLevel: true });
  check(`never longer than ${MAX_LABEL_LENGTH}`, long.length <= MAX_LABEL_LENGTH, long);
  check('and the source and the kind are kept when the group gives way', long.startsWith('★ OpenSubtitles PRO · 1080p AMZN WEB-DL'), long);
  const huge = subtitleLabel(item('Name.'.repeat(40)), {});
  check('a long bare name is cut', huge.length <= MAX_LABEL_LENGTH && huge.endsWith('…'), huge);
}

// ---- the same at every opening: it does not depend on rank or score ----
{
  const a = subtitleLabel(item('Homecoming.S01E07.1080p.AMZN.WEB-DL-NTb'), { filename: HOME });
  const b = subtitleLabel({ ...item('Homecoming.S01E07.1080p.AMZN.WEB-DL-NTb'), downloads: 999, id: 'other' }, { filename: HOME });
  check('same subtitle, same label', a === b);
}

if (failed) {
  console.error(`${failed} label check(s) failed`);
  process.exit(1);
}
console.log('All label checks passed');
