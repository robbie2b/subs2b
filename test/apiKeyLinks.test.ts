// A download link never carries an API key (it goes to the player, the edge cache and the logs): it names the profile, and
// the server reads the key from that profile's configuration.
import os from 'os';
import path from 'path';
import fs from 'fs';
import axios from 'axios';

process.env.DATABASE_URL = '';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'subs2b-keys-'));
process.env.ALLOW_PRIVATE_HOSTS = '1';
delete process.env.VERCEL;

import { OpenSubtitlesProvider } from '../src/providers/openSubtitles';
import { SubsourceProvider } from '../src/providers/subsource';
import { handleOpenSubtitlesRestDownload, handleUnifiedSubtitleProxy, serverCanDownload, keyTagOf, openSubtitlesApiSource } from '../src/proxy/subtitleProxy';
import { clearSourceHealth, noteRefusal } from '../src/utils/sourceHealth';
import { configStorage } from '../src/storage/configStore';
import { mergeWithDefaults } from '../src/config/userConfig';
import { getAggregatedSubtitles, parseSubtitleQuery } from '../src/core/aggregator';

let failed = 0;
function check(label: string, ok: boolean, info?: unknown): void {
  if (ok) console.log('  ok  ' + label);
  else { failed++; console.error('FAIL ' + label, info !== undefined ? JSON.stringify(info) : ''); }
}
const SRT = '1\n00:00:01,000 --> 00:00:02,000\nhello there, this is a subtitle\n\n2\n00:00:03,000 --> 00:00:04,000\nsecond line of the subtitle\n';
const respond = () => {
  const out: { status: number; body: string } = { status: 200, body: '' };
  const res: any = {
    status(c: number) { out.status = c; return res; }, type() { return res; }, setHeader() { /* */ },
    send(b: string) { out.body = String(b); return res; }, json(b: unknown) { out.body = JSON.stringify(b); return res; }, redirect() { return res; }
  };
  return { res, out };
};

(async () => {
  const KEY = 'os-secret-key-0123456789';
  const SUBSOURCE_KEY = 'ss-secret-key-abcdefghij';
  await configStorage.initialize();
  const uuid = 'c0000000-0000-4000-8000-0000000000c1';
  await configStorage.saveConfigAsync(uuid, 'password-key', mergeWithDefaults({
    providers: { opensubtitles: { enabled: true, apiKey: KEY }, subsource: { enabled: true, apiKey: SUBSOURCE_KEY } }, customAddons: []
  }));

  const realGet = axios.get; const realPost = axios.post;
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  (axios as any).get = async (url: string, cfg: any = {}) => {
    seen.push({ url, headers: cfg.headers || {} });
    if (url.includes('api.opensubtitles.com/api/v1/subtitles')) return { data: { data: [{ id: '1', attributes: { files: [{ file_id: 555, file_name: 'Movie.2020.1080p.WEB-DL-GRP.srt' }], language: 'ro', release: 'Movie.2020.1080p.WEB-DL-GRP' } }] } };
    if (url === 'https://dl.example/api-file' || url.includes('api.subsource.net/api/v1/subtitles/77/download')) return { data: new Uint8Array(Buffer.from(SRT)).buffer };
    if (url.includes('api.subsource.net/api/v1/movies/search')) return { data: { data: [{ movieId: 9, type: 'movie', title: 'Movie' }] } };
    if (url.includes('api.subsource.net/api/v1/subtitles')) return { data: { subtitles: [{ subtitleId: 77, language: 'romanian', releaseInfo: ['Movie.2020.1080p.WEB-DL-GRP'] }] } };
    if (url === 'https://dl.example/api-file' || url.includes('api.subsource.net/api/v1/subtitles/77/download')) return { data: new Uint8Array(Buffer.from(SRT)).buffer };
    throw Object.assign(new Error('not mocked: ' + url), { response: { status: 404 } });
  };
  (axios as any).post = async (url: string, _b: unknown, cfg: any = {}) => { seen.push({ url, headers: cfg.headers || {} }); return { data: { link: 'https://dl.example/api-file' } }; };
  const q = parseSubtitleQuery('movie', 'tt0000001', { filename: 'Movie.2020.1080p.WEB-DL-GRP.mkv' });
  const ctx = (id: string, key: string) => ({ config: mergeWithDefaults({ languages: ['ron'] }), providerConfig: { enabled: true, apiKey: key } as any, timeoutMs: 3000, providerId: id }) as any;

  try {
    const os1 = await new OpenSubtitlesProvider().search(q, ctx('opensubtitles', KEY));
    const ss = await new SubsourceProvider().search(q, ctx('subsource', SUBSOURCE_KEY));
    check('OpenSubtitles items were found', os1.length === 1, os1.length);
    check('Subsource items were found', ss.length === 1, ss.length);
    check('the OpenSubtitles link holds no key, only its short hash', !os1[0].url.includes(KEY) && !/apiKey=/i.test(os1[0].url) && os1[0].url.includes(`kt=${keyTagOf(KEY)}`), os1[0].url);
    check('the Subsource link holds no key', !ss[0].url.includes(SUBSOURCE_KEY) && !/apiKey=/i.test(ss[0].url) && ss[0].url.includes('p=subsource'), ss[0].url);

    // the list the player gets: the links name the profile, and the key is nowhere in the answer
    const config = mergeWithDefaults({ languages: ['ron'], subsync: false, providers: { opensubtitles: { enabled: true, apiKey: KEY }, subsource: { enabled: true, apiKey: SUBSOURCE_KEY } }, customAddons: [] });
    const list = await getAggregatedSubtitles(q, config, 'https://addon.example', uuid);
    const text = JSON.stringify(list);
    const tokenOf = (u: string): string => { const m = /\/sub\/(?:fallback|aligned)\/([^/]+)\.srt$/.exec(u); return m ? Buffer.from(m[1].split('.')[0], 'base64url').toString('utf8') : u; };
    const readable = list.subtitles.map(s => tokenOf(s.url)).join(' ');
    check('the list has the links of both sources (as one subtitle with a backup: same release)', /os-rest/.test(readable) && /p=subsource/.test(readable), readable.slice(0, 300));
    check('no API key is in the list sent to the player (not even inside the tokens)', !text.includes(KEY) && !text.includes(SUBSOURCE_KEY) && !readable.includes(KEY) && !readable.includes(SUBSOURCE_KEY));
    check('the links name the profile instead', (readable.match(/[?&]c=c0000000-0000-4000-8000-0000000000c1/g) || []).length >= 2, readable.slice(0, 400));

    // the server reads the key from the configuration when the link is followed
    seen.length = 0;
    let r = respond();
    await handleOpenSubtitlesRestDownload({ params: { fileId: '555' }, query: { c: uuid, kt: keyTagOf(KEY), filename: 'x.srt' } } as any, r.res);
    check('the OpenSubtitles download uses the profile\'s key', r.out.status === 200 && seen.some(s => s.url.includes('/api/v1/download') && s.headers['Api-Key'] === KEY), seen.map(s => s.url));

    seen.length = 0;
    r = respond();
    await handleUnifiedSubtitleProxy({ params: {}, query: { url: 'https://api.subsource.net/api/v1/subtitles/77/download', p: 'subsource', c: uuid, filename: 'x.srt' }, headers: {} } as any, r.res);
    const sent = seen.find(s => s.url.includes('subsource.net/api/v1/subtitles/77/download'));
    check('the Subsource download uses the profile\'s key', r.out.status === 200 && sent?.headers['X-API-Key'] === SUBSOURCE_KEY, [r.out.status, sent]);

    seen.length = 0;
    r = respond();
    await handleUnifiedSubtitleProxy({ params: {}, query: { url: 'https://api.subsource.net/api/v1/subtitles/77/download', p: 'subsource', c: 'f0000000-0000-4000-8000-0000000000f9', filename: 'x.srt' }, headers: {} } as any, r.res);
    const none = seen.find(s => s.url.includes('subsource.net/api/v1/subtitles/77/download'));
    check('a profile that does not exist gives no key', !none || !none.headers['X-API-Key'], none);

    seen.length = 0;
    r = respond();
    await handleUnifiedSubtitleProxy({ params: {}, query: { url: 'https://dl.example/x.srt', p: 'subsource', c: uuid, filename: 'x.srt' }, headers: {} } as any, r.res);
    check('the key is sent only to Subsource, not to another host', !seen.some(s => s.headers['X-API-Key'] === SUBSOURCE_KEY), seen);

    // a link made before 1.6.3 (with the key in it) still works
    seen.length = 0;
    r = respond();
    await handleOpenSubtitlesRestDownload({ params: { fileId: '555' }, query: { apiKey: KEY, filename: 'x.srt' } } as any, r.res);
    check('an older link that carries the key still downloads', r.out.status === 200 && seen.some(s => s.headers['Api-Key'] === KEY));

    // the "quota reached" memory works from the hash alone
    clearSourceHealth();
    check('with no block the subtitle is downloadable', serverCanDownload({ url: `/proxy/download/os-rest/1?kt=${keyTagOf(KEY)}` }));
    noteRefusal(openSubtitlesApiSource(KEY), 406, 'quota', undefined as never);
  } finally {
    (axios as any).get = realGet; (axios as any).post = realPost;
  }
  if (failed) { console.error(`${failed} FAIL`); process.exit(1); }
  console.log('apiKeyLinks: all ok');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
