// The timing kept for the Debug page: of a list (search, ranking, early stop) and of a subtitle (where its time went)
process.env.DATABASE_URL = '';
delete process.env.VERCEL;

import http from 'http';
import { AddressInfo } from 'net';
import { getAggregatedSubtitles, parseSubtitleQuery } from '../src/core/aggregator';
import { getDebug } from '../src/utils/debugLog';
import { recordAlignment, getAlignments } from '../src/storage/alignmentLogStore';
import { DEFAULT_USER_CONFIG } from '../src/config/userConfig';
import { UserConfig } from '../src/types/config';

let failed = 0;
function check(label: string, ok: boolean, info?: unknown): void {
  if (ok) console.log('  ok  ' + label);
  else { failed++; console.error('FAIL ' + label, info !== undefined ? JSON.stringify(info) : ''); }
}

async function main(): Promise<void> {
  const KEY = '5b7c0d2e-1111-4222-8333-000000000001';
  const server = http.createServer((req, res) => {
    const slow = (req.url || '').startsWith('/slow/');
    const answer = () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ subtitles: [{ url: `https://dl.example/${slow ? 's' : 'f'}.srt`, lang: 'ron', title: slow ? 'Movie.2001.720p.WEB-DL.x264-OTHER' : 'Movie.2001.1080p.BluRay.x264-GRP' }] })); };
    if (slow) setTimeout(answer, 1500); else answer();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const addon = (id: string) => ({ id, name: id, manifestUrl: `${base}/${id}/manifest.json`, enabled: true, selectedResources: ['subtitles'] });
  const config = (patch: Partial<UserConfig>): UserConfig => ({ ...DEFAULT_USER_CONFIG, providers: {}, languages: ['ron'], deduplication: false, subsync: false, customAddons: [addon('fast'), addon('slow')], ...patch });
  const file = { filename: 'Movie.2001.1080p.BluRay.x264-GRP.mkv' };

  // a full search: the timing shows the search, ranking and total
  await getAggregatedSubtitles(parseSubtitleQuery('movie', 'tt0000031', file), config({ dynamicTimeout: false }), 'http://x', KEY);
  const full = getDebug(KEY)[0] as any;
  check('a list has its timing', !!full?.timing && typeof full.timing.totalMs === 'number', full?.timing);
  check('the search took the slow source\'s time', full.timing.searchMs >= 1300 && full.timing.totalMs >= full.timing.searchMs, full.timing);
  check('not stopped early without the dynamic timeout', full.timing.stoppedEarly === false);

  // stopped early: the timing says so, and the source not waited for is marked in the providers
  await getAggregatedSubtitles(parseSubtitleQuery('movie', 'tt0000032', file), config({ dynamicTimeout: true }), 'http://x', KEY);
  const early = getDebug(KEY)[0] as any;
  check('stopped early is recorded', early.timing.stoppedEarly === true && early.timing.searchMs < 1000, early.timing);
  check('the source not waited for is marked', (early.providers || []).some((p: any) => p.id === 'slow' && p.waived === true), early.providers);

  // a saved list: no search time
  await getAggregatedSubtitles(parseSubtitleQuery('movie', 'tt0000031', file), config({ dynamicTimeout: false }), 'http://x', KEY);
  const cached = getDebug(KEY)[0] as any;
  check('a saved list has no search time', cached.cached === true && cached.timing.searchMs === 0, cached.timing);

  // a subtitle: its timing is kept with the decision and comes back
  recordAlignment(KEY, {
    at: new Date().toISOString(), id: 'tt0000031', filename: 'x.mkv', subtitle: 'Some.Release', outcome: 'unchanged', offset: 0,
    confidence: 0.9, reason: 'already aligned', references: [], ms: 12,
    timing: { subtitleMs: 190, referencesMs: 200, computeMs: 120, readyAfterMs: 400, askedAfterMs: 2100, waitedMs: 1 }
  });
  const back = (await getAlignments(KEY))[0];
  check('the timing of a subtitle is kept with its decision', back?.timing?.readyAfterMs === 400 && back.timing.askedAfterMs === 2100 && back.timing.waitedMs === 1, back?.timing);

  server.close();
  if (failed) { console.error(`${failed} timing record check(s) failed`); process.exit(1); }
  console.log('All timing record checks passed');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
