import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import axios from 'axios';
import AdmZip from 'adm-zip';
import { SubsroDirectProvider, seasonsOf, choosePacks, entriesFor, entryToken, excludesEpisode } from '../src/providers/subsroDirect';
import { clearSubsroMemory } from '../src/storage/subsroStore';
import { handleSubsroDownload } from '../src/proxy/subsroDownload';
import { DEFAULT_USER_CONFIG } from '../src/config/userConfig';
import { SubtitleQuery } from '../src/types/provider';

// Subs.ro through its own API: which packs are opened, what is kept, and the one request each pack costs

let failed = 0;
function check(label: string, ok: boolean, info?: unknown): void {
  if (ok) console.log('  ok  ' + label);
  else { failed++; console.error('FAIL ' + label, info !== undefined ? JSON.stringify(info) : ''); }
}

const SRT = (text: string) => `1\n00:00:01,000 --> 00:00:03,000\n${text}\n\n2\n00:00:04,000 --> 00:00:06,000\nsecond line\n`;
const series = (imdbId: string, season: number, episode: number) => ({ id: `${imdbId}:${season}:${episode}`, imdbId, type: 'series', season, episode } as SubtitleQuery);
const movie = (imdbId: string) => ({ id: imdbId, imdbId, type: 'movie', season: null, episode: null } as SubtitleQuery);

async function main(): Promise<void> {
  // --- reading the titles and descriptions ---
  check('"Sezonul 4"', JSON.stringify(seasonsOf({ title: 'Family Guy - Sezonul 4' })) === '{"from":4,"to":4}');
  check('"Sezoanele 1-24"', JSON.stringify(seasonsOf({ title: 'Family Guy - Sezoanele 1-24' })) === '{"from":1,"to":24}');
  check('the description when the title says nothing', seasonsOf({ title: 'Family Guy', description: 'Sezonul 7 complet' })?.from === 7);
  check('nothing to read', seasonsOf({ title: 'The Fall' }) === null);

  const items = [
    { id: 1, title: 'Show - Sezonul 23', language: 'ro', updatedAt: '2025-03-01T00:00:00Z' },
    { id: 2, title: 'Show - Sezoanele 1-24', language: 'ro', updatedAt: '2025-02-01T00:00:00Z' },
    { id: 3, title: 'Show - Sezonul 4', language: 'ro', updatedAt: '2024-01-01T00:00:00Z' },
    { id: 4, title: 'Show - Sezonul 4', language: 'en', updatedAt: '2024-01-02T00:00:00Z' },
    { id: 5, title: 'Show - Sezonul 5', language: 'ro', updatedAt: '2024-01-03T00:00:00Z' },
    { id: 6, title: 'Show - Sezonul 4', language: 'alt', updatedAt: '2024-01-04T00:00:00Z' }
  ];
  const picked = choosePacks(items, { season: 4, episode: 20 }, ['ron']).map(i => i.id);
  check('a series opens only the packs of its season, in the languages wanted (not season 23, 5, English, "alt")', JSON.stringify(picked) === '[2,3]', picked);
  check('English too when wanted', choosePacks(items, { season: 4, episode: 20 }, ['ron', 'eng']).length === 3);
  check('a film: at most three packs, whatever the languages', choosePacks(items, { season: null, episode: null }, ['ron']).length === 3);
  check('a pack that says it holds other episodes is left out ("Ep.1-4", "Ep. 3"), an unclear one is not',
    excludesEpisode('Ep.1-4', 20) && !excludesEpisode('Ep.1-4', 3) && excludesEpisode('Ep. 3', 4) && !excludesEpisode('Sezonul 4 complet', 20) && !excludesEpisode('NOU! Episodul 15. Sezonul 12, ep. 14-15', 3) && !excludesEpisode('', 5));
  const film = [
    { id: 11, title: 'Film', description: 'Film.2017.720p.BluRay.x264-FGT', language: 'ro', updatedAt: '2018-04-01T00:00:00Z' },
    { id: 12, title: 'Film', description: 'Film.2017.2160p.UHD.BluRay.REMUX.HEVC.TrueHD.7.1-OMFUG', language: 'ro', updatedAt: '2018-03-01T00:00:00Z' },
    { id: 13, title: 'Film', description: 'Film (2017), pentru WEB-DL', language: 'ro', updatedAt: '2018-05-01T00:00:00Z' }
  ];
  const byFile = choosePacks(film, { season: null, episode: null }, ['ron'], 'Film.2017.2160p.UHD.BluRay.REMUX.HEVC.TrueHD.7.1-OMFUG.mkv').map(i => i.id);
  check('the pack that describes the playing file\'s release goes first', byFile[0] === 12, byFile);

  const entries = [
    'DSNP/Show.S04.1080p.DSNP.WEB-DL-PHOENiX/Show.S04E20.Patriot.Games.1080p.DSNP.WEB-DL-PHOENiX.srt',
    'DSNP/Show.S04.DSNP.WEB-DL-VELUN/Show.S04E20.Patriot.Games.DSNP.WEB-DL-VELUN.ro.srt',
    'DSNP/Show.S04.DSNP.WEB-DL-VELUN/Show.S04E21.Other.DSNP.WEB-DL-VELUN.ro.srt',
    'DSNP/Show.S05.DSNP.WEB-DL-VELUN/Show.S05E20.Wrong.Season.srt'
  ];
  const mine = entriesFor(entries, { season: 4, episode: 20 });
  check('only the files of the episode (both releases), not another episode or season', mine.length === 2 && mine.every(n => /S04E20/.test(n)), mine);
  check('a film takes every file', entriesFor(['a.srt', 'b.srt'], { season: null, episode: null }).length === 2);

  // --- the provider, with a faked API ---
  const pack = new AdmZip();
  pack.addFile('Show.S04.1080p.DSNP.WEB-DL-PHOENiX/Show.S04E20.Patriot.Games.1080p.DSNP.WEB-DL-PHOENiX.srt', Buffer.from(SRT('Salut, și ț')));
  pack.addFile('Show.S04.DSNP.WEB-DL-VELUN/Show.S04E20.Patriot.Games.DSNP.WEB-DL-VELUN.ro.srt', Buffer.from(SRT('hello two')));
  pack.addFile('Show.S04.DSNP.WEB-DL-VELUN/Show.S04E21.Other.DSNP.WEB-DL-VELUN.ro.srt', Buffer.from(SRT('other episode')));
  const packBytes = pack.toBuffer();

  const calls: string[] = [];
  const realGet = axios.get;
  (axios as any).get = async (url: string, opts?: any) => {
    calls.push(url.replace('https://api.subs.ro/v1.0', ''));
    if (opts?.headers?.['X-Subs-Api-Key'] !== 'test-key-1234567890') throw Object.assign(new Error('unauthorized'), { response: { status: 401 } });
    if (url.endsWith('/quota')) return { status: 200, data: { quota: { used: 10, remaining: 290, total: 300, type: 'api_key' } } };
    if (url.includes('/search/imdbid/tt0182576')) return { status: 200, data: { status: 200, items: [
      { id: 2, title: 'Family Guy - Sezoanele 1-24', language: 'ro', updatedAt: '2025-02-01T00:00:00Z' },
      { id: 3, title: 'Family Guy - Sezonul 4', language: 'ro', updatedAt: '2024-01-01T00:00:00Z' },
      { id: 5, title: 'Family Guy - Sezonul 5', language: 'ro', updatedAt: '2024-01-03T00:00:00Z' },
      { id: 121280, title: 'Family Guy - Sezonul 23', language: 'ro', updatedAt: '2025-03-01T00:00:00Z' }
    ] } };
    if (/\/subtitle\/(2|3)\/download$/.test(url)) return { status: 200, data: new Uint8Array(packBytes).buffer };
    throw new Error('unexpected request ' + url);
  };

  const provider = new SubsroDirectProvider();
  const config = { ...DEFAULT_USER_CONFIG, languages: ['ron'] };
  const context = { config, providerConfig: { enabled: true, apiKey: 'test-key-1234567890' }, timeoutMs: 5000 } as any;
  clearSubsroMemory();

  const first = await provider.searchWithStatus(series('tt0182576', 4, 20), context);
  const costly = calls.filter(c => !c.endsWith('/quota'));
  check('a new series: one search and one pack of season 4 (it holds two releases of the episode), none of the other seasons', costly.length === 2 && costly[0].startsWith('/search/') && /\/subtitle\/(2|3)\/download/.test(costly[1]), costly);
  check('every file of the episode is a subtitle, named as its release', !first.failed && first.items.length === 2 && first.items.some(i => /PHOENiX/.test(i.release || '')) && first.items.some(i => /VELUN/.test(i.release || '')), first.items.map(i => i.release));
  check('the links are this server\'s own (no key in them)', first.items.every(i => i.url.startsWith('/proxy/download/subsro/') && i.url.endsWith('.srt') && !/test-key/.test(i.url)), first.items[0]?.url);
  check('the provider is Subs.ro, in Romanian', first.items.every(i => i.lang === 'ron' && i.providerName === 'Subs.ro'));

  calls.length = 0;
  const again = await provider.searchWithStatus(series('tt0182576', 4, 21), context);
  check('the next episode costs at most the other pack, not a new search (the search and the first pack are kept)', calls.filter(c => !c.endsWith('/quota')).length === 1 && /\/subtitle\/(2|3)\/download/.test(calls.filter(c => !c.endsWith('/quota'))[0]) && again.items.length === 2 && again.items.every(i => /S04E21/.test(i.release || '')), { calls, n: again.items.length });

  calls.length = 0;
  const refs = await provider.searchWithStatus({ ...series('tt0182576', 4, 20), allLanguages: true }, context);
  check('the timing references never spend a request here', refs.items.length === 0 && calls.length === 0, calls);
  const noKey = await provider.searchWithStatus(series('tt0182576', 4, 20), { ...context, providerConfig: { enabled: true, apiKey: '' } });
  check('without a key nothing is asked', noKey.items.length === 0 && calls.length === 0, calls);

  // a film: the best pack has enough subtitles, so the others are not opened (one request each)
  const filmPack = new AdmZip();
  ['A', 'B', 'C', 'D', 'E'].forEach((g, n) => filmPack.addFile(`Film.2017.2160p.UHD.BluRay.REMUX.HEVC-${g}${n}.srt`, Buffer.from(SRT('film ' + g))));
  const filmBytes = filmPack.toBuffer();
  calls.length = 0;
  (axios as any).get = async (url: string) => {
    calls.push(url.replace('https://api.subs.ro/v1.0', ''));
    if (url.endsWith('/quota')) return { status: 200, data: { quota: { used: 1, remaining: 299, total: 300 } } };
    if (url.includes('/search/imdbid/tt7777771')) return { status: 200, data: { items: [
      { id: 21, title: 'Film', description: 'Film.2017.720p.BluRay.x264-FGT', language: 'ro', updatedAt: '2018-04-01T00:00:00Z' },
      { id: 22, title: 'Film', description: 'Film.2017.2160p.UHD.BluRay.REMUX.HEVC-OMFUG', language: 'ro', updatedAt: '2018-03-01T00:00:00Z' },
      { id: 23, title: 'Film', description: 'Film (2017), pentru WEB-DL', language: 'ro', updatedAt: '2018-05-01T00:00:00Z' }
    ] } };
    if (/\/subtitle\/\d+\/download$/.test(url)) return { status: 200, data: new Uint8Array(filmBytes).buffer };
    throw new Error('unexpected ' + url);
  };
  const filmOut = await provider.searchWithStatus({ ...movie('tt7777771'), extra: { filename: 'Film.2017.2160p.UHD.BluRay.REMUX.HEVC-OMFUG.mkv' } } as any, context);
  const filmCalls = calls.filter(c => !c.endsWith('/quota'));
  check('a film costs one search and one pack when the best pack has enough subtitles', filmCalls.length === 2 && /\/subtitle\/22\/download/.test(filmCalls[1]) && filmOut.items.length === 5, { filmCalls, n: filmOut.items.length });

  // near the daily limit the source is left alone
  (axios as any).get = async (url: string) => {
    calls.push(url);
    if (url.endsWith('/quota')) return { status: 200, data: { quota: { used: 290, remaining: 10, total: 300 } } };
    throw new Error('must not ask');
  };
  const otherKey = { ...context, providerConfig: { enabled: true, apiKey: 'another-key-9999999999' } };
  calls.length = 0;
  const limited = await provider.searchWithStatus(series('tt0000001', 1, 1), otherKey);
  check('under 15 requests left today: reported as failed, no search made', limited.failed && /limit/.test(limited.error || '') && calls.every(c => c.endsWith('/quota')), { failed: limited.failed, error: limited.error, calls });
  (axios as any).get = realGet;

  // --- the download route: from the kept pack, no request ---
  const app = express();
  app.get('/proxy/download/subsro/:packId/:entry', handleSubsroDownload);
  const server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const link = first.items.find(i => /PHOENiX/.test(i.release || ''))!.url;
  const ok = await axios.get(base + link, { validateStatus: () => true });
  check('the subtitle is served from the pack, in UTF-8', ok.status === 200 && String(ok.data).includes('Salut, și ț') && String(ok.data).includes('00:00:01,000 --> 00:00:03,000'), { status: ok.status, body: String(ok.data).slice(0, 80) });
  const nope = await axios.get(`${base}/proxy/download/subsro/3/${entryToken('../../etc/passwd')}.srt`, { validateStatus: () => true });
  check('a file the pack was not listed with is refused', nope.status === 404, nope.status);
  const unknown = await axios.get(`${base}/proxy/download/subsro/999/${entryToken('x.srt')}.srt`, { validateStatus: () => true });
  check('a pack that is not kept is a 404', unknown.status === 404, unknown.status);
  const bad = await axios.get(`${base}/proxy/download/subsro/abc/${entryToken('x.srt')}.srt`, { validateStatus: () => true });
  check('a pack id that is not a number is refused', bad.status === 400, bad.status);
  server.close();

  // --- the place in the priority list ---
  const { mergeWithDefaults } = await import('../src/config/userConfig');
  const prio = mergeWithDefaults({ providerPriority: ['org.stremio.subsro', 'regielive', 'org.stremio.opensubtitlesv3', 'opensubtitles', 'subsrodirect'] } as any).providerPriority;
  check('Subs.ro (direct) takes the place of the Subs.ro addon in an old priority list', prio[0] === 'subsrodirect' && prio[1] === 'org.stremio.subsro' && prio.filter(i => i === 'subsrodirect').length === 1, prio);
  const prio2 = mergeWithDefaults({ providerPriority: ['regielive', 'subsrodirect', 'org.stremio.subsro'] } as any).providerPriority;
  check('and stays where it is when it is already above the addon', prio2[1] === 'subsrodirect' && prio2[2] === 'org.stremio.subsro', prio2);

  // --- the key check of the Services page (the quota check: free) ---
  const { createServer } = await import('../src/server');
  const appUnderTest = createServer();
  const srv2 = http.createServer(appUnderTest);
  await new Promise<void>(r => srv2.listen(0, '127.0.0.1', r));
  const base2 = `http://127.0.0.1:${(srv2.address() as AddressInfo).port}`;
  const realGet2 = axios.get;
  (axios as any).get = async (url: string, opts?: any) => {
    if (url.startsWith(base2)) return realGet2(url, opts);
    if (url.endsWith('/v1.0/quota')) {
      if (opts?.headers?.['X-Subs-Api-Key'] === 'good-key-12345') return { status: 200, data: { quota: { used: 1, remaining: 299, total: 300 } } };
      return { status: 401, data: { message: 'bad key' } };
    }
    throw new Error('unexpected ' + url);
  };
  const post = (key: string) => axios.request({ url: `${base2}/api/validate-key/subsrodirect`, method: 'POST', data: { apiKey: key }, validateStatus: () => true });
  const okKey = await post('good-key-12345');
  const badKey = await post('wrong-key');
  (axios as any).get = realGet2;
  check('a good Subs.ro key is accepted by the Services page check', okKey.status === 200 && okKey.data?.valid === true, okKey.data);
  check('a wrong Subs.ro key is refused with a reason', badKey.data?.valid === false && /did not accept/.test(badKey.data?.error || ''), badKey.data);
  srv2.close();

  if (failed) { console.error(`${failed} Subs.ro check(s) failed`); process.exit(1); }
  console.log('All Subs.ro checks passed');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
