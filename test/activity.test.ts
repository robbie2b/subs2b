// The live activity feed: what a search reports, step by step, and how the Debug page tells instances apart
process.env.DATABASE_URL = '';
delete process.env.VERCEL;

import http from 'http';
import { AddressInfo } from 'net';
import { getAggregatedSubtitles, parseSubtitleQuery } from '../src/core/aggregator';
import { activity, getActivity, clearActivity, filmLabel, fmtMs } from '../src/utils/activity';
import { INSTANCE_ID } from '../src/utils/logger';
import { DEFAULT_USER_CONFIG } from '../src/config/userConfig';
import { UserConfig } from '../src/types/config';

let failed = 0;
function check(label: string, ok: boolean, info?: unknown): void {
  if (ok) console.log('  ok  ' + label);
  else { failed++; console.error('FAIL ' + label, info !== undefined ? JSON.stringify(info) : ''); }
}

async function main(): Promise<void> {
  // the buffer itself
  clearActivity();
  activity('request', 'Film A', 'one');
  activity('search', 'Film A', 'two');
  const all = getActivity(0);
  check('events are kept in order with a counter and the instance name', all.events.length === 2 && all.events[0].seq < all.events[1].seq && all.instance === INSTANCE_ID, all);
  check('this instance\'s counter cuts the older events', getActivity(all.events[0].seq, INSTANCE_ID).events.length === 1);
  check('a counter of another instance means nothing: everything is sent', getActivity(all.last, 'other').events.length === 2);
  check('labels and times read well', filmLabel('tt1', ' The.File.mkv ') === 'The.File.mkv' && filmLabel('tt1') === 'tt1' && fmtMs(87) === '87 ms' && fmtMs(1234) === '1.2 s' && fmtMs(15400) === '15 s');

  // a search reports its steps
  const server = http.createServer((req, res) => {
    const slow = (req.url || '').startsWith('/slow/');
    const answer = () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ subtitles: [{ url: 'https://dl.example/a.srt', lang: 'ron', title: slow ? 'Movie.2001.720p.WEB-DL.x264-OTHER' : 'Movie.2001.1080p.BluRay.x264-GRP' }] })); };
    if ((req.url || '').startsWith('/broken/')) { res.statusCode = 500; res.end('no'); return; }
    if (slow) setTimeout(answer, 1200); else answer();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const addon = (id: string) => ({ id, name: id, manifestUrl: `${base}/${id}/manifest.json`, enabled: true, selectedResources: ['subtitles'] });
  const config: UserConfig = { ...DEFAULT_USER_CONFIG, providers: {}, languages: ['ron'], deduplication: false, subsync: false, customAddons: [addon('fast'), addon('slow'), addon('broken')], dynamicTimeout: false };

  clearActivity();
  const FILE = 'Movie.2001.1080p.BluRay.x264-GRP.mkv';
  await getAggregatedSubtitles(parseSubtitleQuery('movie', 'tt0000041', { filename: FILE }), config, 'http://x');
  const steps = getActivity(0).events;
  const kinds = steps.map(e => e.kind);
  const text = steps.map(e => e.text).join(' | ');
  check('the steps start with the request and end with the list', kinds[0] === 'request' && kinds[kinds.length - 1] === 'list', kinds);
  check('every step of a search is reported', ['search', 'source', 'rank'].every(k => kinds.includes(k as any)), kinds);
  check('a source that answered is reported with its count and time', /fast: 1 subtitle in \d+ ms/.test(text), text);
  check('a source that failed is reported as failed', /broken failed after/.test(text), text);
  check('the steps are about the file being played', steps.every(e => e.film === FILE));
  const metaSteps = steps.filter(e => e.meta && e.meta.step).map(e => e.meta!.step);
  check('the steps carry what the panel draws: request, search, rank, list', ['request', 'search', 'rank', 'list'].every(k => metaSteps.includes(k as any)), metaSteps);
  const sources = steps.filter(e => e.meta && e.meta.src).map(e => e.meta!.src!);
  check('each source answer carries its state and time', sources.some(s => s.name === 'fast' && s.state === 'ok') && sources.some(s => s.name === 'broken' && s.state === 'fail' && /500/.test(s.error || '')), sources);
  check('the search start lists the sources asked', (steps.find(e => e.meta && e.meta.sources)?.meta?.sources || []).length === 3);
  check('the list step says how long it took and what was sent', /List ready in [\d.]+ (ms|s): 2 subtitles sent to the player/.test(text), text);
  check('the best subtitle is named', /best: "Movie.2001.1080p.BluRay.x264-GRP"/.test(text), text);

  // the second time the list comes from the saved one
  clearActivity();
  await getAggregatedSubtitles(parseSubtitleQuery('movie', 'tt0000041', { filename: FILE }), config, 'http://x');
  check('a saved list is reported as such (no search steps)', getActivity(0).events.some(e => /Saved list found/.test(e.text)) && !getActivity(0).events.some(e => e.kind === 'source'));

  server.close();
  if (failed) { console.error(`${failed} activity check(s) failed`); process.exit(1); }
  console.log('All activity checks passed');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
