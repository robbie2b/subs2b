import http from 'http';
import { AddressInfo } from 'net';
import { getAggregatedSubtitles, parseSubtitleQuery } from '../src/core/aggregator';
import { globalSubtitleCache } from '../src/utils/cache';
import { DEFAULT_USER_CONFIG } from '../src/config/userConfig';
import { UserConfig } from '../src/types/config';

let failed = 0;
function check(label: string, ok: boolean, info?: unknown): void {
  if (ok) console.log('  ok  ' + label);
  else {
    failed++;
    console.error('FAIL ' + label, info !== undefined ? JSON.stringify(info) : '');
  }
}

async function main(): Promise<void> {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits++;
    setTimeout(() => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ subtitles: [{ url: 'https://dl.example/a.srt', lang: 'ron', title: 'Movie.2001.1080p.BluRay-GRP' }] }));
    }, 400);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const addon = (id: string) => ({ id, name: id, manifestUrl: `${base}/${id}/manifest.json`, enabled: true, selectedResources: ['subtitles'] });
  const config: UserConfig = { ...DEFAULT_USER_CONFIG, providers: {}, languages: ['ron'], customAddons: [addon('one')] };
  const query = () => parseSubtitleQuery('movie', 'tt0000002', { filename: 'Movie.2001.1080p.BluRay-GRP.mkv' });

  // the same search asked 3 times at once: the addon is asked once, all three get the list
  const answers = await Promise.all([1, 2, 3].map(() => getAggregatedSubtitles(query(), config, 'http://x')));
  check('three identical searches at once ask the addon once', hits === 1, hits);
  check('all three get the subtitle', answers.every(a => a.subtitles.length === 1), answers.map(a => a.subtitles.length));

  // another set of imported addons is another search (it must not get the first one's answer)
  hits = 0;
  const other: UserConfig = { ...config, customAddons: [addon('two')] };
  await getAggregatedSubtitles(query(), other, 'http://x');
  check('a configuration with other imported addons does not share the cached answer', hits === 1, hits);

  // a failed search does not stay as a running one
  globalSubtitleCache.clear();
  server.close();
  const down = await getAggregatedSubtitles(parseSubtitleQuery('movie', 'tt0000003'), config, 'http://x');
  const again = await getAggregatedSubtitles(parseSubtitleQuery('movie', 'tt0000003'), config, 'http://x');
  check('a search with a failing addon still answers (twice)', down.subtitles.length === 0 && again.subtitles.length === 0);

  if (failed) {
    console.error(`${failed} search sharing check(s) failed`);
    process.exit(1);
  }
  console.log('All search sharing checks passed');
}

main().catch(err => { console.error(err); process.exit(1); });
