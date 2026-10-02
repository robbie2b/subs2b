import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { parseTitrariPage, titrariItems, releasesFromComment, TitrariProvider } from '../src/providers/titrari';
import { parseSubtitrariNoiPage, subtitrariNoiItems } from '../src/providers/subtitrariNoi';
import { parseYifyPage, yifyItems, YifyProvider } from '../src/providers/yify';
import { parseAddic7edEpisode, addic7edItems, showsFromSearch, pickShows } from '../src/providers/addic7ed';
import { wyzieItems, WyzieProvider } from '../src/providers/wyzie';
import { mapWhitelistToIso1 } from '../src/utils/languages';
import AdmZip from 'adm-zip';
import { isAllowedDownloadUrl, handleUnifiedSubtitleProxy } from '../src/proxy/subtitleProxy';
import { mergeWithDefaults } from '../src/config/userConfig';
import { SubtitleQuery } from '../src/types/provider';

// The five sources added in 1.4.12, checked on pages saved from the real sites (fetched from Render with the Debug probe)

let failures = 0;
function check(ok: boolean, label: string, details?: unknown): void {
  if (ok) console.log(`  ok  ${label}`);
  else { failures++; console.error(`FAIL ${label}`, details !== undefined ? JSON.stringify(details) : ''); }
}
const page = (f: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'sources', f), 'utf8');
const series = (imdbId: string, season: number, episode: number) => ({ id: `${imdbId}:${season}:${episode}`, imdbId, type: 'series', season, episode } as SubtitleQuery);
const movie = (imdbId: string) => ({ id: imdbId, imdbId, type: 'movie', season: null, episode: null } as SubtitleQuery);

async function main(): Promise<void> {
  console.log('Titrari.ro');
  {
    const chaser = parseTitrariPage(page('titrari-chaser.html'));
    check(chaser.length === 1 && chaser[0].language === 'Romana' && chaser[0].imdb === 'tt1190539', 'the language is read from its cell, not from the title "[Chugyeogja]"', chaser);
    const items = titrariItems(chaser, movie('tt1190539'));
    check(items[0]?.lang === 'ron' && items[0].release === 'Chaser.2008.DVDRip.XviD-BiFOS', 'the release name comes from the comment', items);
    check(decodeURIComponent(items[0].url).includes('https://www.titrari.ro/get.php?id=59823'), 'the download goes through /sub/proxy');
    check(titrariItems(chaser, movie('tt0000001')).length === 0, 'another IMDb id is dropped');

    const utopia = parseTitrariPage(page('titrari-utopia.html'));
    check(utopia.length === 3, 'every result of the page is read (they share one table)', utopia.map(e => e.id));
    const s1 = titrariItems(utopia, series('tt2384811', 1, 2)).map(i => i.id);
    const s2 = titrariItems(utopia, series('tt2384811', 2, 1));
    check(!s1.includes('titrari-103632') && s2.some(i => i.id === 'titrari-103632'), '"Sezonul 2" is kept only for season 2', { s1, s2: s2.map(i => i.id) });
    check(s2.find(i => i.id === 'titrari-103632')?.release === 'Utopia S02', 'a pack without release names is named after the title and season', s2.map(i => i.release));
    check(releasesFromComment('Utopia, S02 complet, Ep.01-06.') === '', 'words like "Ep.01-06" are not release names');
    check(releasesFromComment('Seven.Days.in.Utopia.2011.1080p.BluRay.x265-RARBG; Seven.Days.in.Utopia.2011.BRRip.XviD-eXceSs si X').split('; ').length === 2, 'release names separated by ";" and "si"');
  }

  console.log('Subtitrari-noi.ro');
  {
    const entries = parseSubtitrariNoiPage(page('subtitrarinoi-utopia.html'));
    check(entries.length === 9, 'every result of the page is read', entries.length);
    const seven = subtitrariNoiItems(entries, movie('tt1699147'));
    check(seven.length === 1 && seven[0].release.split('; ').length === 3 && !/NOU/.test(seven[0].release), 'the release names of a film, without the "NOU!" mark', seven);
    check(decodeURIComponent(seven[0].url).includes('https://www.subtitrari-noi.ro/18667-subtitrari-noi.ro-Seven_Days_in_Utopia_(2011)-873.zip'), 'the ZIP link is absolute');
    const s2 = subtitrariNoiItems(entries, series('tt2384811', 2, 1));
    check(s2.length === 1 && s2[0].release === 'Utopia S02', 'a series: only the right season (search by title, kept by IMDb id)', s2.map(i => i.release));
  }

  console.log('YIFY');
  {
    const items = yifyItems(parseYifyPage(page('yify-matrix.html')));
    check(items.filter(i => i.lang === 'ron').length === 2 && items.some(i => i.lang === 'eng') && items.some(i => i.lang === 'ara'), 'every language of the film page', items.map(i => i.lang));
    const ro = items.find(i => i.lang === 'ron')!;
    check(ro.release === 'The Matrix 1999 720p BrRip 264-YIFY' && decodeURIComponent(ro.url).includes('https://subtitles.yts-subs.com/subtitles/the-matrix-1999-romanian-yify-119127.zip'), 'release name and ZIP link', ro);
  }

  console.log('Addic7ed');
  {
    const shows = showsFromSearch(page('addic7ed-search.html'));
    check(shows.length >= 3, 'the shows of a search', shows.map(s => s.name));
    check(pickShows(shows, 'Utopia', 2020).join() === 'Utopia_%282020%29', 'the show of the right year', pickShows(shows, 'Utopia', 2020));
    const entries = parseAddic7edEpisode(page('addic7ed-episode.html'));
    const items = addic7edItems(entries, series('tt2384811', 1, 2), 'Utopia (UK)', 'https://www.addic7ed.com/serie/Utopia_%28UK%29/1/2/x');
    check(items.length > 0 && items.every(i => /^Utopia\.S01E02[.-]/.test(i.release)), 'release names "Show.S01E02.<version>"', items.map(i => i.release));
    check(items.some(i => i.release === 'Utopia.S01E02.HDTV.x264-FoV' && i.lang === 'hrv'), 'version and language of each link', items.slice(0, 3));
    check(items.every(i => /[?&]ref=/.test(i.url)), 'the download carries the episode page as Referer');
  }

  console.log('Wyzie');
  {
    const sample = [
      { id: '1', url: 'https://sub.wyzie.io/c/x/id/1?tok=t', format: 'srt', language: 'ro', display: 'Romanian', source: 'charlie', releases: ['A.S01E01.1080p.WEB-DL-GRP', 'A.S01E01.720p.WEB-DL-GRP'], isHearingImpaired: false },
      { id: '2', url: 'https://sub.wyzie.io/c/x/id/2?tok=t', format: 'ass', language: 'en' },
      { id: '3', url: 'https://sub.wyzie.io/c/x/id/3?tok=t', format: 'srt', language: 'en', source: 'ai' },
      { id: '4', url: 'https://sub.wyzie.io/c/x/id/4?tok=t', format: 'srt', language: 'en', fileName: 'Movie.2020.1080p.BluRay-X.srt', isHearingImpaired: true }
    ];
    const items = wyzieItems(sample as any);
    check(items.map(i => i.id).join() === 'wyzie-1,wyzie-4', 'formats other than SRT/VTT and AI translations are left out', items.map(i => i.id));
    check(items[0].release === 'A.S01E01.1080p.WEB-DL-GRP; A.S01E01.720p.WEB-DL-GRP' && items[0].lang === 'ron', 'several releases joined with ";"', items[0]);
    check(items[1].release === 'Movie.2020.1080p.BluRay-X' && items[1].hearingImpaired === true, 'the file name when there is no release name');
    check(!items.some(i => /key=/.test(i.url)), 'the key is never in a subtitle link');
    check(mapWhitelistToIso1(['ron', 'eng']).join() === 'ro,en', 'two-letter languages', mapWhitelistToIso1(['ron', 'eng']));

    const realGet = axios.get;
    const asked: any[] = [];
    (axios as any).get = async (_url: string, opts: any) => { asked.push(opts.params); return { status: 400, data: { code: 400, message: 'No subtitles found' } }; };
    const provider = new WyzieProvider();
    const config = mergeWithDefaults({ languages: ['ron'], providers: { wyzie: { enabled: true, apiKey: 'test-key-123' } } as any });
    const out = await provider.searchWithStatus(series('tt2384811', 1, 2), { config, providerConfig: config.providers.wyzie, timeoutMs: 5000 } as any);
    check(!out.failed && out.items.length === 0, '"No subtitles found" is an empty answer, not a failure', out);
    check(asked[0]?.source === 'all' && asked[0]?.language === 'ro' && asked[0]?.season === 1 && asked[0]?.key === 'test-key-123', 'asks every source, the language, the episode, with the key', asked[0]);
    await provider.searchWithStatus({ ...series('tt2384811', 1, 2), allLanguages: true }, { config, providerConfig: config.providers.wyzie, timeoutMs: 5000 } as any);
    check(!('language' in asked[1]), 'the references search asks for every language');
    (axios as any).get = async () => ({ status: 401, data: { code: 401, message: 'Invalid key' } });
    const bad = await provider.searchWithStatus(movie('tt1'), { config, providerConfig: config.providers.wyzie, timeoutMs: 5000 } as any);
    check(bad.failed && /401: Invalid key/.test(bad.error || ''), 'a refused key is a failure with the API message', bad);

    // a site answering a block page is a failure, not "nothing found"
    (axios as any).get = async () => ({ status: 200, data: '<html>Just a moment...</html>' });
    const blocked = await new TitrariProvider().searchWithStatus(movie('tt1190539'), { config, timeoutMs: 5000 } as any);
    check(blocked.failed === true, 'Titrari.ro: a block page is reported as a failure', blocked);
    (axios as any).get = async () => ({ status: 404, data: 'not found' });
    const unknown = await new YifyProvider().searchWithStatus(movie('tt0000001'), { config, timeoutMs: 5000 } as any);
    check(!unknown.failed && unknown.items.length === 0, 'YIFY: a film it does not know (404) is "nothing found"', unknown);
    const seriesOnYify = await new YifyProvider().searchWithStatus(series('tt2384811', 1, 2), { config, timeoutMs: 5000 } as any);
    check(seriesOnYify.items.length === 0 && !seriesOnYify.failed, 'YIFY: films only');
    (axios as any).get = realGet;
  }

  console.log('Downloads and settings');
  for (const u of ['https://www.titrari.ro/get.php?id=1', 'https://www.subtitrari-noi.ro/1-x.zip', 'https://subtitles.yts-subs.com/subtitles/x.zip', 'https://www.addic7ed.com/original/1/0', 'https://sub.wyzie.io/c/x/id/1']) {
    check(isAllowedDownloadUrl(u), `downloads allowed from ${new URL(u).hostname}`);
  }
  {
    // a Titrari.ro archive: asked with the site as Referer, an old Romanian file (ș as 0xBA in code page 1250) read right
    const zip = new AdmZip();
    const srt = '1\r\n00:00:01,000 --> 00:00:02,500\r\nAş vrea să plec acasă.\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nŞi tu?\r\n';
    const win1250 = Buffer.from(srt.replace(/ş/g, '\u00ba').replace(/Ş/g, '\u00aa').replace(/ă/g, '\u00e3'), 'latin1');
    zip.addFile('Film.2020.1080p.BluRay-GRP.srt', win1250);
    const realGet = axios.get;
    let sentHeaders: Record<string, string> = {};
    (axios as any).get = async (_u: string, opts: any) => { sentHeaders = opts.headers; return { status: 200, data: new Uint8Array(zip.toBuffer()).buffer, headers: {} }; };
    const out: { status: number; body: string } = { status: 200, body: '' };
    const res: any = { status(c: number) { out.status = c; return res; }, setHeader() { /* not checked */ }, type() { return res; }, send(b: string) { out.body = String(b); return res; }, json(b: unknown) { out.body = JSON.stringify(b); return res; } };
    await handleUnifiedSubtitleProxy({ query: { url: 'https://www.titrari.ro/get.php?id=1' }, params: {} } as any, res);
    check(sentHeaders.Referer === 'https://www.titrari.ro/' && /Chrome/.test(sentHeaders['User-Agent']), 'Titrari.ro is asked with its Referer, as a browser', sentHeaders);
    // (code page 1250 has the older cedilla forms: ş, Ş)
    check(out.status === 200 && out.body.includes('Aş vrea să plec acasă.') && out.body.includes('Şi tu?'), 'the Romanian letters come out right (not "Aº vrea")', out.body.slice(0, 120));
    await handleUnifiedSubtitleProxy({ query: { url: 'https://www.addic7ed.com/original/1/0', ref: 'https://evil.example/' }, params: {} } as any, res);
    check(sentHeaders.Referer === 'https://www.addic7ed.com/', 'a Referer of another site is never passed on (the site\'s own home page instead)', sentHeaders.Referer);
    (axios as any).get = realGet;
  }
  const cfg = mergeWithDefaults({ providers: { titrari: { enabled: true, apiKey: '' }, wyzie: { enabled: true, apiKey: '' } } as any });
  check(cfg.providers.titrari.enabled === true, 'a site without a key can be switched on without one');

  if (failures) {
    console.error(`${failures} new source check(s) failed`);
    process.exit(1);
  }
  console.log('All new source checks passed');
}

main().catch(err => { console.error(err); process.exit(1); });
