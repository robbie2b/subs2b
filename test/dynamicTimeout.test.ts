import http from 'http';
import { AddressInfo } from 'net';
import { getAggregatedSubtitles, parseSubtitleQuery, searchCacheKey } from '../src/core/aggregator';
import { globalSubtitleCache } from '../src/utils/cache';
import { DEFAULT_USER_CONFIG } from '../src/config/userConfig';
import { UserConfig } from '../src/types/config';
import { setSourceSpeeds, clearSourceSpeeds } from '../src/utils/sourceSpeed';

let failed = 0;
function check(label: string, ok: boolean, info?: unknown): void {
  if (ok) console.log('  ok  ' + label);
  else { failed++; console.error('FAIL ' + label, info !== undefined ? JSON.stringify(info) : ''); }
}

const FILE = 'Movie.2001.1080p.BluRay.x264-GRP.mkv';

async function main(): Promise<void> {
  // "fast" answers at once with the exact release of the playing file; "slow" answers after 3 s with another subtitle
  // (for the tests of failing sources, "fast" waits a little, so the failure is in before the list is closed)
  let fastDelayMs = 0;
  const server = http.createServer((req, res) => {
    if ((req.url || '').startsWith('/broken/')) { res.statusCode = 500; res.end('no'); return; }
    const slow = (req.url || '').startsWith('/slow/');
    const near = (req.url || '').startsWith('/near/');
    // "near": the same kind of release as the playing file (1080p BluRay), but by another group: good, not exact
    const title = slow ? 'Movie.2001.720p.WEB-DL.x264-OTHER' : near ? 'Movie.2001.1080p.BluRay.x264-OTHER' : 'Movie.2001.1080p.BluRay.x264-GRP';
    const answer = () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ subtitles: [{ url: `https://dl.example/${slow ? 's' : 'f'}.srt`, lang: 'ron', title }] })); };
    if (slow) setTimeout(answer, 3000); else if (!near && fastDelayMs) setTimeout(answer, fastDelayMs); else answer();
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

  // 3. an exact match does not wait for a source ranked higher by the user
  const three = await ask('tt0000013', config({ providerPriority: ['slow', 'fast'] }));
  check('an exact match is not held back by a higher-ranked source that has not answered', three.ms < 1500 && three.answer.subtitles.length === 1, { ms: three.ms, n: three.answer.subtitles.length });

  // 3b. a good, not exact, subtitle waits for a higher-ranked source: at most 2 s when its speed is not known...
  const noSpeed = await ask('tt0000031', config({ providerPriority: ['slow', 'near'], dynamicTimeoutScore: 5, customAddons: [addon('near'), addon('slow')] }));
  check('a higher-ranked source of unknown speed is waited for at most 2 s', noSpeed.ms >= 1900 && noSpeed.ms < 2800 && noSpeed.answer.subtitles.length === 1, { ms: noSpeed.ms, n: noSpeed.answer.subtitles.length });
  // ...as long as it usually takes when it is known, and not at all when it often fails
  const speedConfig = (patch: Partial<UserConfig>) => config({ providerPriority: ['slow', 'near'], dynamicTimeoutScore: 5, subsync: false, customAddons: [addon('near'), addon('slow')], ...patch });
  setSourceSpeeds('speed-test', new Map([['slow', { p75: 700, failRate: 0, searches: 50, winRate: 0.3, inTopRate: 0.6, ranked: 50 }]]));
  const t1 = Date.now();
  const quick = await getAggregatedSubtitles(parseSubtitleQuery('movie', 'tt0000033', { filename: FILE }), speedConfig({}), 'http://x', 'speed-test');
  const knownMs = Date.now() - t1;
  check('a source that usually answers in 0.7 s is waited for about 0.7 s', knownMs >= 600 && knownMs < 1400 && quick.subtitles.length === 1, knownMs);
  setSourceSpeeds('speed-test', new Map([['slow', { p75: 700, failRate: 0.5, searches: 50, winRate: 0.3, inTopRate: 0.6, ranked: 50 }]]));
  const t2 = Date.now();
  await getAggregatedSubtitles(parseSubtitleQuery('movie', 'tt0000034', { filename: FILE }), speedConfig({}), 'http://x', 'speed-test');
  check('a source that often fails is not waited for', Date.now() - t2 < 700, Date.now() - t2);
  // below the score wanted, the sources left decide: if they almost never win the list does not wait for them, if one often does it is waited for as long as it usually takes
  const hopeless = (patch: Partial<UserConfig>) => config({ dynamicTimeoutScore: 200, subsync: false, customAddons: [addon('near'), addon('slow')], ...patch });
  setSourceSpeeds('speed-test', new Map([['slow', { p75: 700, failRate: 0, searches: 50, winRate: 0.01, inTopRate: 0.5, ranked: 50 }]]));
  const t4 = Date.now();
  await getAggregatedSubtitles(parseSubtitleQuery('movie', 'tt0000036', { filename: FILE }), hopeless({}), 'http://x', 'speed-test');
  check('below the score wanted, a pending source that wins 1% of the time is not waited for', Date.now() - t4 < 900, Date.now() - t4);
  setSourceSpeeds('speed-test', new Map([['slow', { p75: 700, failRate: 0, searches: 50, winRate: 0.6, inTopRate: 0.9, ranked: 50 }]]));
  const t5 = Date.now();
  await getAggregatedSubtitles(parseSubtitleQuery('movie', 'tt0000037', { filename: FILE }), hopeless({}), 'http://x', 'speed-test');
  const waitedMs = Date.now() - t5;
  check('one that wins 60% of the time is waited for as long as it usually takes (twice its usual time), then given up', waitedMs >= 1300 && waitedMs < 2300, waitedMs);

  // a failed source that almost never wins does not make the list incomplete (so it is kept the whole time); one that often wins does
  const failing = (patch: Partial<UserConfig>) => config({ subsync: false, customAddons: [addon('fast'), addon('broken')], ...patch });
  fastDelayMs = 150;
  setSourceSpeeds('speed-test', new Map([['broken', { p75: 100, failRate: 1, searches: 50, winRate: 0, inTopRate: 0, ranked: 50 }]]));
  const calm = await getAggregatedSubtitles(parseSubtitleQuery('movie', 'tt0000041', { filename: FILE }), failing({}), 'http://x', 'speed-test');
  check('a failure of a source that never wins leaves the list complete (kept the full time)', calm.cacheMaxAge === Math.round(DEFAULT_USER_CONFIG.cacheTtlMinutes * 60), calm.cacheMaxAge);
  setSourceSpeeds('speed-test', new Map([['broken', { p75: 100, failRate: 0.3, searches: 50, winRate: 0.4, inTopRate: 0.8, ranked: 50 }]]));
  const worried = await getAggregatedSubtitles(parseSubtitleQuery('movie', 'tt0000042', { filename: FILE }), failing({}), 'http://x', 'speed-test');
  check('a failure of a source that often wins keeps the list for 2 minutes only', worried.cacheMaxAge === 120, worried.cacheMaxAge);

  // a source that almost never brings the best subtitle is not waited for either
  setSourceSpeeds('speed-test', new Map([['slow', { p75: 700, failRate: 0, searches: 50, winRate: 0, inTopRate: 0.05, ranked: 50 }]]));
  const t3 = Date.now();
  await getAggregatedSubtitles(parseSubtitleQuery('movie', 'tt0000035', { filename: FILE }), speedConfig({}), 'http://x', 'speed-test');
  check('a source that almost never wins is not waited for', Date.now() - t3 < 700, Date.now() - t3);
  clearSourceSpeeds();

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
