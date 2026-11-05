import http from 'http';
import { AddressInfo } from 'net';
import { getAggregatedSubtitles, parseSubtitleQuery, searchCacheKey } from '../src/core/aggregator';
import { globalSubtitleCache } from '../src/utils/cache';
import { DEFAULT_USER_CONFIG } from '../src/config/userConfig';
import { UserConfig } from '../src/types/config';

let failed = 0;
function check(label: string, ok: boolean, info?: unknown): void {
  if (ok) console.log('  ok  ' + label);
  else { failed++; console.error('FAIL ' + label, info !== undefined ? JSON.stringify(info) : ''); }
}

const FILE = 'Movie.2001.1080p.BluRay.x264-GRP.mkv';

async function main(): Promise<void> {
  // "fast" answers at once with the exact release of the playing file; "slow" answers after 3 s with another subtitle
  const server = http.createServer((req, res) => {
    const slow = (req.url || '').startsWith('/slow/');
    const near = (req.url || '').startsWith('/near/');
    // "near": the same kind of release as the playing file (1080p BluRay), but by another group: good, not exact
    const title = slow ? 'Movie.2001.720p.WEB-DL.x264-OTHER' : near ? 'Movie.2001.1080p.BluRay.x264-OTHER' : 'Movie.2001.1080p.BluRay.x264-GRP';
    const answer = () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ subtitles: [{ url: `https://dl.example/${slow ? 's' : 'f'}.srt`, lang: 'ron', title }] })); };
    if (slow) setTimeout(answer, 3000); else answer();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const addon = (id: string) => ({ id, name: id, manifestUrl: `${base}/${id}/manifest.json`, enabled: true, selectedResources: ['subtitles'] });
  const config = (patch: Partial<UserConfig> = {}): UserConfig => ({
    ...DEFAULT_USER_CONFIG, providers: {}, languages: ['ron'], providerTimeoutMs: 6000, deduplication: false,
    customAddons: [addon('fast'), addon('slow')], dynamicTimeout: true, ...patch
  });
  const ask = async (id: string, cfg: UserConfig, withFile = true) => {
    const query = parseSubtitleQuery('movie', id, withFile ? { filename: FILE } : {});
    const t0 = Date.now();
    const answer = await getAggregatedSubtitles(query, cfg, 'http://x');
    return { ms: Date.now() - t0, answer, key: searchCacheKey(query, cfg) };
  };

  // 1. something good arrives at once: the list does not wait for the slow source, and the saved list is completed later
  const one = await ask('tt0000011', config());
  check('with the dynamic timeout the list is ready long before the slow source answers', one.ms < 1500, one.ms);
  check('the list has the good subtitle', one.answer.subtitles.length === 1 && /GRP/.test(one.answer.subtitles[0].title), one.answer.subtitles.map(s => s.title));
  check('an early list is kept for a short time only', one.answer.cacheMaxAge === 120, one.answer.cacheMaxAge);
  check('the saved list at that moment is the early one', globalSubtitleCache.get(one.key)?.length === 1);
  await new Promise(r => setTimeout(r, 3500));
  check('when the slow source has answered, the saved list is the whole one', globalSubtitleCache.get(one.key)?.length === 2, globalSubtitleCache.get(one.key)?.length);

  // 2. the setting off: the whole wait
  const two = await ask('tt0000012', config({ dynamicTimeout: false }));
  check('without the dynamic timeout the list waits for the slow source', two.ms >= 2800 && two.answer.subtitles.length === 2, { ms: two.ms, n: two.answer.subtitles.length });

  // 3. a source ranked higher by the user than the one with the good subtitle is waited for
  const three = await ask('tt0000013', config({ providerPriority: ['slow', 'fast'] }));
  check('a higher-ranked source that has not answered is waited for', three.ms >= 2800 && three.answer.subtitles.length === 2, { ms: three.ms, n: three.answer.subtitles.length });

  // 4. nothing to judge by (no file name, no hash): no early stop
  const four = await ask('tt0000014', config(), false);
  check('without the file name nothing is judged and everything is waited for', four.ms >= 2800, four.ms);

  // 5. the score threshold: a subtitle that is not the playing release needs the score
  const five = await ask('tt0000015', config({ dynamicTimeoutScore: 200, customAddons: [addon('slow')] }));
  check('a single source is simply waited for', five.ms >= 2800, five.ms);

  // 6. a good subtitle that is not the exact release counts by its score
  const low = await ask('tt0000016', config({ dynamicTimeoutScore: 5, customAddons: [addon('near'), addon('slow')] }));
  check('a low score threshold stops the wait for a good, not exact, subtitle', low.ms < 1500, low.ms);
  const high = await ask('tt0000017', config({ dynamicTimeoutScore: 200, customAddons: [addon('near'), addon('slow')] }));
  check('a score the subtitle does not reach: everything is waited for', high.ms >= 2800, high.ms);

  server.close();
  if (failed) { console.error(`${failed} dynamic timeout check(s) failed`); process.exit(1); }
  console.log('All dynamic timeout checks passed');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
