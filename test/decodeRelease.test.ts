import { decodeReleaseFromUrl } from '../src/providers/genericStremioAddon';

const name = 'Spider-Man.Far.from.Home.2019.1080p.BluRay.x264-DON.srt';
const enc = Buffer.from(name).toString('base64url');
const cases: Array<[string, string | null]> = [
  [`https://x.example/KEY/proxy/12345/${enc}/sub.vtt`, 'Spider-Man.Far.from.Home.2019.1080p.BluRay.x264-DON'],
  [`https://x.example/KEY/proxy/1/${Buffer.from('WEB-DL 3 variante/Guardians.of.the.Galaxy.Vol.3.2023.srt').toString('base64url')}/sub.vtt`, 'Guardians.of.the.Galaxy.Vol.3.2023 [WEB-DL 3 variante]'],
  [`https://x.example/KEY/proxy/1/${Buffer.from('CAM/Guardians.2023.2160p.CAM.NEW.AUDIO.srt').toString('base64url')}/sub.vtt`, 'Guardians.2023.2160p.CAM.NEW.AUDIO'],
  ['https://x.example/subs/12345/sub.vtt', null],
  ['https://x.example/KEYKEYKEYKEYKEYKEYKEYKEYKEY/proxy/1/sub.vtt', null]
];

let failed = 0;
for (const [url, expected] of cases) {
  const got = decodeReleaseFromUrl(url);
  if (got !== expected) {
    failed++;
    console.error('FAIL', url, '->', got, 'expected', expected);
  }
}
if (failed) process.exit(1);
console.log('decodeRelease OK');
