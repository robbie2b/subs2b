import AdmZip from 'adm-zip';
import { pickSubsRoEntry } from '../src/proxy/subtitleProxy';

function zipWith(names: string[]): AdmZip {
  const zip = new AdmZip();
  for (const n of names) zip.addFile(n, Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nhi\n'));
  return zip;
}

const season = zipWith([
  'Friends.S03E08.720p.BluRay.x264-GRP.srt',
  'Friends.S03E09.720p.BluRay.x264-GRP.srt',
  'Friends.S03E19.720p.BluRay.x264-GRP.srt'
]);
const cases: Array<[string, AdmZip, number | null, number | null, string | null]> = [
  ['S03E09 exact', season, 3, 9, 'Friends.S03E09.720p.BluRay.x264-GRP.srt'],
  ['E1 must not match E19', zipWith(['Show.S01E19.srt', 'Show.S01E01.srt']), 1, 1, 'Show.S01E01.srt'],
  ['1x05 style', zipWith(['Show 1x04.srt', 'Show 1x05.srt']), 1, 5, 'Show 1x05.srt'],
  ['missing episode in multi-file pack', season, 3, 12, null],
  ['single file pack accepted', zipWith(['whatever.srt']), 3, 12, 'whatever.srt'],
  ['movie takes first', zipWith(['Movie.2019.srt']), null, null, 'Movie.2019.srt']
];

let failed = 0;
for (const [label, zip, s, e, expected] of cases) {
  const got = pickSubsRoEntry(zip, s, e);
  const name = got ? got.entryName : null;
  if (name !== expected) {
    failed++;
    console.error('FAIL', label, '->', name, 'expected', expected);
  }
}
if (failed) process.exit(1);
console.log('subsroPick OK');
