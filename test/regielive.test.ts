import axios from 'axios';
import AdmZip from 'adm-zip';
import iconv from 'iconv-lite';
import {
  RegieLiveProvider, RateLimiter, parseRegieLiveResponse, encodeTicket, decodeTicket, regieLiveHeaders, regieLiveApiKey
} from '../src/providers/regielive';
import { subtitleFromRegieLiveArchive, handleRegieLiveDownload } from '../src/proxy/subtitleProxy';
import { isMicroDvd, microDvdToSrt } from '../src/utils/subtitleFormat';
import { mergeWithDefaults } from '../src/config/userConfig';
import { SubtitleQuery } from '../src/types/provider';

let failed = 0;
function check(label: string, ok: boolean, info?: unknown): void {
  if (ok) console.log('  ok  ' + label);
  else {
    failed++;
    console.error('FAIL ' + label, info !== undefined ? JSON.stringify(info) : '');
  }
}

// A response with the shape the real API returns (checked against api.regielive.ro/bazarr/search.php)
const FRIENDS = {
  rezultate: {
    '1248': {
      film: 'Friends',
      subtitrari: {
        '53410': { titlu: 'Friends - 309 - The One With The Football Game', rating: { nota: 5, voturi: 3 }, url: 'https://subtitrari.regielive.ro/descarca-1248-53410.zip' },
        '63018': { titlu: 'Friends - 3x09 - TOW The Football', rating: { nota: 4, voturi: 1 }, url: 'https://subtitrari.regielive.ro/descarca-1248-63018.zip' },
        '564201': { titlu: 'Friends.S03E09.The.One.with.the.Football.1080p.HMAX.WEB-DL.DD5.1.H.264-playWEB', rating: { nota: 0, voturi: 0 }, url: 'https://subtitrari.regielive.ro/descarca-1248-564201.zip' },
        '999': { titlu: 'broken record', url: 'https://subtitrari.regielive.ro/descarca-1248-0.zip' },
        '998': { titlu: 'other host', url: 'https://evil.example.com/descarca-1248-998.zip' }
      }
    },
    '77': {
      film: 'Friends with Benefits',
      subtitrari: { '5': { titlu: 'Friends.with.Benefits.2011.BluRay', url: 'https://subtitrari.regielive.ro/descarca-77-5.zip' } }
    }
  }
};

function srt(text: string): string {
  return `1\r\n00:00:01,000 --> 00:00:03,000\r\n${text}\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000\r\nal doilea rând\r\n`;
}

async function main() {
  // ---- parsing the search response ----
  console.log('Search response');
  const items = parseRegieLiveResponse(FRIENDS, { cookie: 'PHPSESSID=abc', season: 3, episode: 9, videoFilename: 'Friends.S03E09.mkv', referenceTitle: 'Friends' });
  check('the valid subtitles become items', items.length === 3, items.map(i => i.id));
  check('the broken "-0.zip" record is skipped', !items.some(i => i.id === 'regielive-999'));
  check('a link to another host is skipped', !items.some(i => i.id === 'regielive-998'));
  check('another film ("Friends with Benefits") is skipped for a title search', !items.some(i => i.id === 'regielive-5'));
  check('the real release name is kept (used for scoring)', items.some(i => i.release.includes('HMAX.WEB-DL') && i.release.endsWith('playWEB')));
  check('language and provider', items.every(i => i.lang === 'ron' && i.provider === 'regielive'));
  check('rating is kept', items.find(i => i.id === 'regielive-53410')?.rating === 5);
  const ticket = decodeTicket(items[0].url.split('/').pop() || '');
  check('the link carries what is needed to download and choose the file', ticket?.u.startsWith('https://subtitrari.regielive.ro/') === true && ticket?.c === 'PHPSESSID=abc' && ticket?.s === 3 && ticket?.e === 9 && ticket?.vf === 'Friends.S03E09.mkv', ticket);
  check('a bad ticket is refused', decodeTicket('not-base64-json') === null);
  const noFilter = parseRegieLiveResponse(FRIENDS, {});
  check('without a reference title (file-name search) no film is dropped', noFilter.length === 4, noFilter.length);

  // ---- API identification and key ----
  console.log('Identification');
  check('requests identify subs2b', /subs2b/.test(regieLiveHeaders('k')['User-Agent']));
  check('key goes in the RL-API header', regieLiveHeaders('mykey')['RL-API'] === 'mykey');
  check('a personal key wins over the shared one', regieLiveApiKey('  personal ') === 'personal');
  check('without a personal key a shared key is used', regieLiveApiKey('').length > 5);

  // ---- rate limiter ----
  console.log('Rate limiter');
  {
    const limiter = new RateLimiter(2, 10, 10, 300);
    const done: number[] = [];
    await limiter.run(async () => done.push(1));
    await limiter.run(async () => done.push(2));
    let refused = false;
    try {
      await limiter.run(async () => done.push(3));
    } catch {
      refused = true;
    }
    check('a third call within the minute is refused instead of hammering the API', refused && done.length === 2, done);

    const burst = new RateLimiter(100, 2, 10, 2000);
    const started: number[] = [];
    const t0 = Date.now();
    await Promise.all([1, 2, 3].map(() => burst.run(async () => { started.push(Date.now() - t0); })));
    check('at most 2 calls per second (the third waits)', started[2] >= 900, started);

    const concurrent = new RateLimiter(100, 100, 1, 3000);
    let running = 0;
    let maxRunning = 0;
    await Promise.all([1, 2, 3].map(() => concurrent.run(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise(r => setTimeout(r, 40));
      running--;
    })));
    check('concurrency limit is respected', maxRunning === 1, maxRunning);
  }

  // ---- provider with a faked network ----
  console.log('Provider');
  const calls: Array<{ url: string; params: Record<string, string>; headers: Record<string, string> }> = [];
  let mode: 'ok' | '404' | 'error' = 'ok';
  const realGet = axios.get;
  (axios as any).get = async (url: string, config: any = {}) => {
    if (url.includes('cinemeta')) {
      return { status: 200, data: { meta: { name: 'Friends', year: '1994', releaseInfo: '1994–2004' } }, headers: {} };
    }
    calls.push({ url, params: config.params || {}, headers: config.headers || {} });
    if (mode === 'error') throw new Error('connect ECONNRESET');
    if (mode === '404') return { status: 404, data: {}, headers: {} };
    const fileSearch = 'fisier' in (config.params || {});
    const data = fileSearch
      ? { rezultate: { '1248': { film: 'Friends', subtitrari: { '564201': FRIENDS.rezultate['1248'].subtitrari['564201'], '70001': { titlu: 'Friends.S03E09.720p.HDTV.x264-AAA', url: 'https://subtitrari.regielive.ro/descarca-1248-70001.zip' } } } } }
      : FRIENDS;
    return { status: 200, data, headers: { 'set-cookie': ['PHPSESSID=sess123; path=/; secure', 'RLSecKey=1; path=/'] } };
  };

  const provider = new RegieLiveProvider();
  const query: SubtitleQuery = { type: 'series', id: 'tt0108778:3:9', imdbId: 'tt0108778', season: 3, episode: 9, kitsuId: null, extra: { filename: 'Friends.S03E09.1080p.WEB-DL-playWEB.mkv' } };
  const ctx = { config: mergeWithDefaults({}), providerConfig: { enabled: true, apiKey: '' }, timeoutMs: 5000 };

  const out = await provider.searchWithStatus(query, ctx);
  check('search works and is not reported as failed', out.failed === false && out.items.length >= 3, { failed: out.failed, n: out.items.length });
  const byName = calls.find(c => 'nume' in c.params);
  const byFile = calls.find(c => 'fisier' in c.params);
  check('title search: name + season/episode (no year for series)', byName?.params.nume === 'Friends' && byName?.params.sezon === '3' && byName?.params.episod === '9' && !('an' in (byName?.params || {})), byName?.params);
  check('file-name search: the playing file without extension', byFile?.params.fisier === 'Friends.S03E09.1080p.WEB-DL-playWEB', byFile?.params);
  check('both searches carry the key header', calls.every(c => Boolean(c.headers['RL-API'])));
  check('results of both searches are merged without duplicates', new Set(out.items.map(i => i.id)).size === out.items.length && out.items.some(i => i.id === 'regielive-70001'), out.items.map(i => i.id));
  const t = decodeTicket(out.items[0].url.split('/').pop() || '');
  check('the session cookie of the search is passed on for the download (PHPSESSID only)', t?.c === 'PHPSESSID=sess123', t?.c);

  const movieCalls = calls.length;
  await provider.searchWithStatus({ type: 'movie', id: 'tt0133093', imdbId: 'tt0133093', season: null, episode: null, kitsuId: null }, ctx);
  const movieSearch = calls.slice(movieCalls).find(c => 'nume' in c.params);
  check('movie search sends the year', movieSearch?.params.an === '1994', movieSearch?.params);
  check('without a file name there is only the title search', calls.slice(movieCalls).every(c => !('fisier' in c.params)));

  mode = '404';
  const empty = await provider.searchWithStatus({ ...query, id: 'tt0108778:3:10', season: 3, episode: 10 }, ctx);
  check('"not found" (404) is an empty answer, not a failure', empty.failed === false && empty.items.length === 0, empty);

  mode = 'error';
  const broken = await provider.searchWithStatus({ ...query, id: 'tt0108778:3:11', season: 3, episode: 11 }, ctx);
  check('a network error is reported as a failure (shown in Debug)', broken.failed === true && /ECONNRESET/.test(broken.error || ''), broken);
  (axios as any).get = realGet;

  // ---- archives: charset, junk files, languages, MicroDVD, packs ----
  console.log('Archives');
  const zipOf = (files: Record<string, Buffer | string>) => {
    const zip = new AdmZip();
    for (const [name, data] of Object.entries(files)) zip.addFile(name, Buffer.isBuffer(data) ? data : Buffer.from(data));
    return zip.toBuffer();
  };

  // Windows-1250 has the cedilla letters (ş ţ) that old Romanian subtitles use, plus ă î â
  const romanianCp1250 = iconv.encode(srt('Şi pentru voi e ziua ştiută. Ţara, aţi putea să mă ajutaţi, în casă, câine'), 'win1250');
  const plain = await subtitleFromRegieLiveArchive(zipOf({
    'Friends.S03E09.1080p.HMAX.WEB-DL-playWEB.srt': romanianCp1250,
    'Biblioteca RegieLive - Referate, Proiecte.url': '[InternetShortcut] URL=https://regielive.net/'
  }));
  check('the subtitle is taken, not the advertising shortcut', plain.valid && plain.filename.endsWith('.srt'), plain);
  check('old Romanian charset (Windows-1250): ş ţ ă î â come out right', plain.content.includes('Şi pentru voi e ziua ştiută. Ţara, aţi putea să mă ajutaţi, în casă, câine'), plain.content);
  check('the text is not corrupted (no replacement characters)', !plain.content.includes('�'));

  const utf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(srt('Și pentru voi e Ziua Recunoștinței.'))]);
  const utf8 = await subtitleFromRegieLiveArchive(zipOf({ 'a.srt': utf8Bom }));
  check('UTF-8 with BOM is kept as is', utf8.valid && utf8.content.includes('Și pentru voi e Ziua Recunoștinței.') && !utf8.content.startsWith('﻿'), utf8.content.slice(0, 60));

  const multiLang = await subtitleFromRegieLiveArchive(zipOf({
    'Show.S01E01.uk-hi.srt': srt('English hearing impaired'),
    'Show.S01E01.ro.srt': srt('romanian text'),
    'Show.S01E01.uk.srt': srt('English')
  }));
  check('an archive with several languages gives the Romanian one', multiLang.content.includes('romanian text'), multiLang.content);

  const micro = '{100}{200}Salut|lume\n{300}{400}Al doilea';
  check('MicroDVD is recognised', isMicroDvd(micro) && !isMicroDvd(srt('x')));
  const converted = microDvdToSrt(micro);
  check('MicroDVD frames become times (23.976 fps)', converted.includes('00:00:04,171 --> 00:00:08,342') && converted.includes('Salut\nlume'), converted);
  const sub = await subtitleFromRegieLiveArchive(zipOf({ 'film.sub': micro, 'readme.url': 'x' }));
  check('a .sub archive is converted to SRT', sub.valid && sub.content.includes('-->') && sub.content.includes('Salut'), sub);

  const pack = zipOf({ 'Show.S02E01.ro.srt': srt('one'), 'Show.S02E02.ro.srt': srt('two'), 'Show.S02E03.ro.srt': srt('three') });
  const ep = await subtitleFromRegieLiveArchive(pack, { season: 2, episode: 3 });
  check('a season pack gives the requested episode', ep.content.includes('three'), ep.content);

  const junk = await subtitleFromRegieLiveArchive(Buffer.from('<html><title>Access denied</title></html>'));
  check('an HTML page instead of an archive is rejected', junk.valid === false, junk);

  let rarRefused = false;
  try {
    await subtitleFromRegieLiveArchive(Buffer.concat([Buffer.from('Rar!\x1a\x07\x01\x00'), Buffer.alloc(64)]));
  } catch {
    rarRefused = true;
  }
  check('a corrupt RAR archive fails cleanly (no crash)', rarRefused);

  // ---- the download route ----
  console.log('Download route');
  const respond = () => {
    const out: { status: number; headers: Record<string, string>; body: string } = { status: 200, headers: {}, body: '' };
    const res: any = {
      status(code: number) { out.status = code; return res; },
      setHeader(k: string, v: string) { out.headers[k] = v; },
      send(b: string) { out.body = String(b); return res; }
    };
    return { res, out };
  };

  const goodTicket = encodeTicket({ u: 'https://subtitrari.regielive.ro/descarca-1248-564201.zip', c: 'PHPSESSID=sess123', s: 3, e: 9 });
  let attempts = 0;
  const seenHeaders: Array<Record<string, string>> = [];
  (axios as any).get = async (_url: string, config: any) => {
    attempts++;
    seenHeaders.push(config.headers);
    if (attempts === 1) {
      const err: any = new Error('Request failed with status code 429');
      err.isAxiosError = true;
      err.response = { status: 429 };
      throw err;
    }
    return { status: 200, data: new Uint8Array(zipOf({ 'x.S03E09.ro.srt': srt('Ați putea') })).buffer };
  };
  (axios as any).isAxiosError = (e: any) => e && e.isAxiosError === true;

  const ok = respond();
  await handleRegieLiveDownload({ params: { data: goodTicket }, query: {} } as any, ok.res);
  check('a temporary 429 is retried and then succeeds', ok.out.status === 200 && ok.out.body.includes('Ați putea') && attempts === 2, { status: ok.out.status, attempts });
  check('the download sends the session cookie and RegieLive headers', seenHeaders.every(h => h.Cookie === 'PHPSESSID=sess123' && Boolean(h['RL-API']) && h.Referer === 'https://subtitrari.regielive.ro'), seenHeaders[0]);
  check('served as SRT text', /text\/plain/.test(ok.out.headers['Content-Type'] || ''), ok.out.headers);

  const evil = respond();
  attempts = 0;
  await handleRegieLiveDownload({ params: { data: encodeTicket({ u: 'https://169.254.169.254/latest/meta-data' }) }, query: {} } as any, evil.res);
  check('a link to any other host is refused (no open proxy)', evil.out.status === 400 && attempts === 0, evil.out);

  const http = respond();
  await handleRegieLiveDownload({ params: { data: encodeTicket({ u: 'http://subtitrari.regielive.ro/x.zip' }) }, query: {} } as any, http.res);
  check('plain http is refused', http.out.status === 400);

  const garbage = respond();
  await handleRegieLiveDownload({ params: { data: 'garbage' }, query: {} } as any, garbage.res);
  check('a malformed ticket is refused', garbage.out.status === 400);
  (axios as any).get = realGet;

  if (failed) {
    console.error(failed + ' RegieLive check(s) failed');
    process.exit(1);
  }
  console.log('All RegieLive checks passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
