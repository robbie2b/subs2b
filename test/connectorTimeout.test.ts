import http from 'http';
import { AddressInfo } from 'net';
import { executeParallelSearch } from '../src/providers';
import { SubtitleQuery, ProviderReport } from '../src/types/provider';
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
  // two imported addons: one answers at once, one only after 3 s
  const server = http.createServer((req, res) => {
    const answer = () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ subtitles: [{ url: 'https://dl.example/a.srt', lang: 'ron', title: 'Movie.2001.1080p.BluRay-GRP' }] })); };
    if ((req.url || '').startsWith('/slow/')) setTimeout(answer, 3000); else answer();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const addon = (id: string) => ({ id, name: id, manifestUrl: `${base}/${id}/manifest.json`, enabled: true, selectedResources: ['subtitles'],
    // saved with the 20 s every imported addon got at import
    timeout: 20000 });
  const config: UserConfig = { ...DEFAULT_USER_CONFIG, providers: {}, providerTimeoutMs: 1000, customAddons: [addon('slow'), addon('fast')] };
  const query: SubtitleQuery = { type: 'movie', id: 'tt0000001', imdbId: 'tt0000001', season: null, episode: null, kitsuId: null };

  const report: ProviderReport[] = [];
  const t0 = Date.now();
  const items = await executeParallelSearch(query, config, report);
  const total = Date.now() - t0;
  const slow = report.find(r => r.id === 'slow');
  const fast = report.find(r => r.id === 'fast');
  check('the Connector timeout limits an imported addon too (the list is ready in ~1 s, not 3 s or 20 s)', total >= 900 && total < 2000, total);
  check('the slow addon is skipped, with the reason', !!slow && !slow.ok && /timed out after 1000ms/.test(slow.error || ''), slow);
  check('the fast addon is kept', !!fast && fast.ok && fast.count === 1 && items.length === 1, { fast, items: items.length });

  // a longer Connector timeout lets the slow addon in (the saved 20 s of the addon does not matter either way)
  const patient: UserConfig = { ...config, providerTimeoutMs: 5000 };
  const report2: ProviderReport[] = [];
  const items2 = await executeParallelSearch(query, patient, report2);
  check('with a longer Connector timeout the slow addon answers too', items2.length === 2 && report2.every(r => r.ok), report2);

  server.close();
  if (failed) {
    console.error(`${failed} connector timeout check(s) failed`);
    process.exit(1);
  }
  console.log('All connector timeout checks passed');
}

main().catch(err => { console.error(err); process.exit(1); });
