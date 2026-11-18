// A bad request or a database blip must answer with an error, never hang the player or end the process.
import os from 'os';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { AddressInfo } from 'net';
import axios from 'axios';

process.env.DATABASE_URL = '';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'subs2b-rob-'));
delete process.env.VERCEL;

import { createServer } from '../src/server';
import { configStorage } from '../src/storage/configStore';
import { mergeWithDefaults } from '../src/config/userConfig';
import { searchCacheKey, parseSubtitleQuery } from '../src/core/aggregator';
import { BaseSubtitleProvider } from '../src/providers/base';

let failed = 0;
function check(label: string, ok: boolean, info?: unknown): void {
  if (ok) console.log('  ok  ' + label);
  else { failed++; console.error('FAIL ' + label, info !== undefined ? JSON.stringify(info) : ''); }
}

(async () => {
  await configStorage.initialize();
  const uuid = 'e0000000-0000-4000-8000-0000000000e1';
  await configStorage.saveConfigAsync(uuid, 'password-rob', mergeWithDefaults({ providers: {}, customAddons: [] }));
  const app = http.createServer(createServer());
  await new Promise<void>(r => app.listen(0, '127.0.0.1', r));
  const client = axios.create({ baseURL: `http://127.0.0.1:${(app.address() as AddressInfo).port}`, validateStatus: () => true, timeout: 5000 });
  let rejections = 0;
  process.on('unhandledRejection', () => { rejections++; });
  try {
    const r1 = await client.get('/sub/proxy', { params: { 'url[]': 'https://example.com/x.zip' }, paramsSerializer: { serialize: () => 'url[]=https://example.com/x.zip' } });
    check('an array in ?url[]= is an error answer, not a crash', r1.status === 400, r1.status);
    check('an error answer is never kept (no-store)', r1.headers['cache-control'] === 'no-store', r1.headers['cache-control']);
    const r404 = await client.get('/proxy/download/subsro/nothing/pick.srt');
    check('a 4xx from a route that sets no header is no-store too', r404.status >= 400 && r404.headers['cache-control'] === 'no-store', { s: r404.status, c: r404.headers['cache-control'] });
    const r3 = await client.post('/api/validate-key/subdl', { apiKey: 123 });
    check('a number as API key is "no key", not a crash', r3.status === 200 && r3.data.valid === false, r3.data);
    const r4 = await client.post('/api/manifest/validate', { url: 1 });
    check('a number as manifest url is a 400', r4.status === 400, r4.status);
    // profiles with other API keys never share a saved list (its links carry the owner's key)
    const q = parseSubtitleQuery('movie', 'tt0000001', {});
    const withKey = (k: string) => mergeWithDefaults({ providers: { opensubtitles: { enabled: true, apiKey: k } } });
    check('two profiles with other API keys have other list keys', searchCacheKey(q, withKey('aaaaaaaaaaaaaaaa')) !== searchCacheKey(q, withKey('bbbbbbbbbbbbbbbb')));
    check('the same keys give the same list key (the cache still works)', searchCacheKey(q, withKey('aaaaaaaaaaaaaaaa')) === searchCacheKey(q, withKey('aaaaaaaaaaaaaaaa')));
    check('the key itself is not in the list key', !searchCacheKey(q, withKey('aaaaaaaaaaaaaaaa')).includes('aaaaaaaa'));

    // an address with a UUID that was never saved is not a profile
    const ghost = await client.get('/f0000000-0000-4000-8000-0000000000f1/subtitles/movie/tt0000002/filename=Some.File.2020.1080p.WEB-DL-GRP.mkv.json');
    check('a made-up UUID gets an empty list without a search', ghost.status === 200 && ghost.data.subtitles.length === 0, ghost.data);
    // a gateway error that comes back at once is tried once more; a slow or a 429 one is not
    class Probe extends BaseSubtitleProvider {
      readonly id = 'probe'; readonly name = 'Probe'; readonly description = ''; readonly requiresApiKey = false; readonly defaultEnabled = false;
      protected async executeSearch(): Promise<never[]> { return []; }
      get(url: string) { return this.httpGet<{ ok: boolean }>(url, { timeout: 3000 }); }
    }
    const calls: Record<string, number> = {};
    const flaky = http.createServer((req, res) => {
      const key = req.url || '';
      calls[key] = (calls[key] || 0) + 1;
      if (key === '/blink' && calls[key] === 1) { res.statusCode = 502; res.end('bad gateway'); return; }
      if (key === '/limited') { res.statusCode = 429; res.end('slow down'); return; }
      res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}');
    });
    await new Promise<void>(r => flaky.listen(0, '127.0.0.1', r));
    const flakyBase = `http://127.0.0.1:${(flaky.address() as AddressInfo).port}`;
    const probe = new Probe();
    const blinked = await probe.get(`${flakyBase}/blink`);
    check('a 502 that came back at once is retried and the answer is used', blinked.data.ok === true && calls['/blink'] === 2, calls);
    let limitedStatus = 0;
    try { await probe.get(`${flakyBase}/limited`); } catch (err: unknown) { limitedStatus = (err as { response?: { status?: number } }).response?.status ?? 0; }
    check('a 429 is not retried', limitedStatus === 429 && calls['/limited'] === 1, calls);
    flaky.close();

    const r5 = await client.get('/health');
    check('the server is still alive after all that', r5.status === 200);

    // the database cannot be read: the player routes answer 503 at once, they do not hang
    const original = configStorage.getConfigByUuidAsync.bind(configStorage);
    (configStorage as unknown as { getConfigByUuidAsync: unknown }).getConfigByUuidAsync = async () => { throw new Error('database is not reachable'); };
    try {
      const t0 = Date.now();
      const a = await client.get(`/${uuid}/sub/aligned/abc.srt`);
      const f = await client.get(`/${uuid}/sub/fallback/abc.srt`);
      const c = await client.get(`/${uuid}/sub/convert.srt`, { params: { url: 'https://example.com/a.vtt' } });
      check('with the database down, the aligned / fallback / convert routes answer 503 at once', a.status === 503 && f.status === 503 && c.status === 503 && Date.now() - t0 < 3000, [a.status, f.status, c.status]);
      check('and the error is never cached', String(a.headers['cache-control']).includes('no-store'));
    } finally {
      (configStorage as unknown as { getConfigByUuidAsync: unknown }).getConfigByUuidAsync = original;
    }
    await new Promise(r => setTimeout(r, 200));
    check('nothing was left as an unhandled rejection', rejections === 0, rejections);
  } finally {
    app.close();
  }
  if (failed) { console.error(`${failed} FAIL`); process.exit(1); }
  console.log('robustness: all ok');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
