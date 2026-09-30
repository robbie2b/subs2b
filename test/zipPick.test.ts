import AdmZip from 'adm-zip';
import { decompressBuffer, pickArchiveEntry } from '../src/proxy/subtitleProxy';

let failed = 0;
function check(label: string, ok: boolean, info?: unknown): void {
  if (ok) console.log('  ok  ' + label);
  else {
    failed++;
    console.error('FAIL ' + label, info !== undefined ? JSON.stringify(info) : '');
  }
}

function srt(text: string): string {
  return `1\n00:00:01,000 --> 00:00:03,000\n${text}\n`;
}

function makeZip(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, text] of Object.entries(files)) zip.addFile(name, Buffer.from(srt(text)));
  return zip.toBuffer();
}

const text = (b: Buffer) => b.toString('utf8');

// ---- season pack: one subtitle per episode ----
const pack = makeZip({
  'Show.S01E01.720p.WEB.x264-GRP.srt': 'episode ONE',
  'Show.S01E02.720p.WEB.x264-GRP.srt': 'episode TWO',
  'Show.S01E03.720p.WEB.x264-GRP.srt': 'episode THREE'
});

const before = decompressBuffer(pack);
check('BEFORE (no information): the first file is taken, which is episode 1', text(before.buffer).includes('episode ONE'));

const ep3 = decompressBuffer(pack, { season: 1, episode: 3 });
check('AFTER: asking for episode 3 gives episode 3', text(ep3.buffer).includes('episode THREE'), text(ep3.buffer));
check('AFTER: the extracted file name is the episode 3 one', ep3.filename === 'Show.S01E03.720p.WEB.x264-GRP.srt', ep3.filename);

const ep2 = decompressBuffer(pack, { season: 1, episode: 2, videoFilename: 'Show.S01E02.1080p.BluRay.x264-OTHER.mkv' });
check('AFTER: with a video file name too, episode 2 is still episode 2', text(ep2.buffer).includes('episode TWO'));

// ---- names that only carry the number ----
const loose = makeZip({
  'Show - 01.srt': 'loose ONE',
  'Show - 02.srt': 'loose TWO',
  'Show - 10.srt': 'loose TEN'
});
check('BEFORE: number-only names, first file', text(decompressBuffer(loose).buffer).includes('loose ONE'));
check('AFTER: number-only names, episode 2', text(decompressBuffer(loose, { season: 1, episode: 2 }).buffer).includes('loose TWO'));
check('AFTER: episode 10 is not confused with episode 1', text(decompressBuffer(loose, { season: 1, episode: 10 }).buffer).includes('loose TEN'));

const withE = makeZip({ 'Show E05.srt': 'E five', 'Show E06.srt': 'E six' });
check('AFTER: "E06" style names', text(decompressBuffer(withE, { season: 1, episode: 6 }).buffer).includes('E six'));

// ---- one episode, several releases: the one that looks like the playing file ----
const releases = makeZip({
  'Movie.2020.720p.WEB.x264-AAA.srt': 'release AAA',
  'Movie.2020.1080p.BluRay.x264-BBB.srt': 'release BBB',
  'Movie.2020.2160p.WEB-DL.DV.HEVC-CCC.srt': 'release CCC'
});
// (archives list their files alphabetically, so the first one is the 1080p BluRay release)
check('BEFORE: several releases, the first file regardless of what is playing', text(decompressBuffer(releases).buffer).includes('release BBB'));
const byName = decompressBuffer(releases, { videoFilename: 'Movie.2020.2160p.WEB-DL.DV.HEVC-CCC.mkv' });
check('AFTER: the release matching the playing file (2160p WEB-DL)', text(byName.buffer).includes('release CCC'), text(byName.buffer));

const byNameEpisodes = makeZip({
  'Show.S02E04.720p.HDTV.x264-AAA.srt': 'wrong episode',
  'Show.S02E05.1080p.WEB.h264-BBB.srt': 'ep5 BBB',
  'Show.S02E05.720p.HDTV.x264-CCC.srt': 'ep5 CCC'
});
const combined = decompressBuffer(byNameEpisodes, { season: 2, episode: 5, videoFilename: 'Show.S02E05.720p.HDTV.x264-CCC.mkv' });
check('AFTER: right episode, then the release matching the file', text(combined.buffer).includes('ep5 CCC'), text(combined.buffer));

// ---- must not break the simple cases ----
const single = makeZip({ 'only.srt': 'the only one' });
check('a single-file archive is unchanged', text(decompressBuffer(single, { season: 1, episode: 4, videoFilename: 'x.mkv' }).buffer).includes('the only one'));

const nomatch = makeZip({ 'A.S01E01.srt': 'a1', 'A.S01E02.srt': 'a2' });
check('episode not in the archive: falls back to the first file', text(decompressBuffer(nomatch, { season: 1, episode: 9 }).buffer).includes('a1'));

const mixed = makeZip({ 'readme.txt': 'not a subtitle', 'Show.S01E02.srt': 'real two', 'Show.S01E01.srt': 'real one' });
check('non-subtitle files are ignored when .srt files exist', text(decompressBuffer(mixed, { season: 1, episode: 2 }).buffer).includes('real two'));

check('pickArchiveEntry without pick keeps the first .srt', pickArchiveEntry([{ entryName: 'b.vtt' }, { entryName: 'c.srt' }, { entryName: 'a.srt' }])?.entryName === 'c.srt');

if (failed) {
  console.error(failed + ' archive check(s) failed');
  process.exit(1);
}
console.log('All archive checks passed');
