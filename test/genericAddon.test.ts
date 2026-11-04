import http from 'http';
import { AddressInfo } from 'net';
import { GenericStremioAddonProvider, extraPathOf } from '../src/providers/genericStremioAddon';
import { SubtitleQuery, ProviderContext } from '../src/types/provider';
import { DEFAULT_USER_CONFIG } from '../src/config/userConfig';

let failed = 0;
function check(label: string, ok: boolean, info?: unknown): void {
  if (ok) console.log('  ok  ' + label);
  else {
    failed++;
    console.error('FAIL ' + label, info !== undefined ? JSON.stringify(info) : '');
  }
}

const query = (extra?: SubtitleQuery['extra']): SubtitleQuery =>
  ({ type: 'movie', id: 'tt0241527', imdbId: 'tt0241527', season: null, episode: null, kitsuId: null, extra });
const context: ProviderContext = { config: DEFAULT_USER_CONFIG, providerConfig: { enabled: true }, timeoutMs: 5000 };

async function main(): Promise<void> {
  // ---- the path the addon is asked on ----
  check('no file information: nothing added', extraPathOf(query()) === '' && extraPathOf(query({})) === '');
  check('hash, size and name in the Stremio form, encoded', extraPathOf(query({ videoHash: '86b7c91049aca433', videoSize: '123456', filename: "Harry Potter & the Sorcerer's Stone.mkv" }))
    === "videoHash=86b7c91049aca433&videoSize=123456&filename=Harry%20Potter%20%26%20the%20Sorcerer's%20Stone.mkv");
  check('other arguments are not passed on', extraPathOf(query({ filename: 'a.mkv', secret: 'x' })) === 'filename=a.mkv');
  check('an empty value is left out', extraPathOf(query({ videoHash: '', filename: 'a.mkv' })) === 'filename=a.mkv');

  // ---- a mock addon that takes the extra, one that does not, one that fails ----
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url || '');
    const url = req.url || '';
    const answer = (subs: unknown[]) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ subtitles: subs })); };
    if (url.startsWith('/modern/')) return answer([{ url: 'https://dl.example/a.srt', lang: 'ron', title: url.includes('videoHash=') ? 'for-the-file' : 'any-copy' }]);
    if (url.startsWith('/old/')) {
      // an addon that only knows the plain path
      if (url.includes('/tt0241527.json')) return answer([{ url: 'https://dl.example/b.srt', lang: 'ron', title: 'plain-answer' }]);
      res.statusCode = 404; return res.end('not found');
    }
    if (url.startsWith('/broken/')) { res.statusCode = 500; return res.end('boom'); }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const file = { videoHash: '86b7c91049aca433', videoSize: '99', filename: 'Movie.2001.2160p-GRP.mkv' };

  const modern = new GenericStremioAddonProvider('modern', 'Modern', `${base}/modern/manifest.json`);
  seen.length = 0;
  let items = await modern.search(query(file), context);
  check('the addon is asked with the file information', seen.length === 1 && seen[0].includes('/subtitles/movie/tt0241527/videoHash=86b7c91049aca433&videoSize=99&filename=Movie.2001.2160p-GRP.mkv.json'), seen);
  check('and answers for the exact file', items.length === 1 && items[0].release === 'for-the-file', items);

  seen.length = 0;
  items = await modern.search(query(), context);
  check('without file information the plain path is used', seen.length === 1 && seen[0].endsWith('/subtitles/movie/tt0241527.json') && items[0].release === 'any-copy', seen);

  const old = new GenericStremioAddonProvider('old', 'Old', `${base}/old/manifest.json`);
  seen.length = 0;
  items = await old.search(query(file), context);
  check('an addon that refuses the extra path is asked the plain way (one more try)', seen.length === 2 && items.length === 1 && items[0].release === 'plain-answer', seen);

  const broken = new GenericStremioAddonProvider('broken', 'Broken', `${base}/broken/manifest.json`);
  seen.length = 0;
  const outcome = await broken.searchWithStatus(query(file), context);
  check('a server error is a failure, not retried', outcome.failed && seen.length === 1, { seen, outcome });

  server.close();
  if (failed) {
    console.error(`${failed} generic addon check(s) failed`);
    process.exit(1);
  }
  console.log('All generic addon checks passed');
}

main().catch(err => { console.error(err); process.exit(1); });
