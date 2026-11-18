// The list follows the user's languages: Romanian first, then English; the limit counts per language, so the 3 shown are
// not 3 of one language chosen by score over the whole list.
import http from 'http';
import { AddressInfo } from 'net';
process.env.ALLOW_PRIVATE_HOSTS = '1';

import { groupByLanguage, capPerLanguage, getAggregatedSubtitles, parseSubtitleQuery } from '../src/core/aggregator';
import { DEFAULT_USER_CONFIG } from '../src/config/userConfig';
import { UserConfig } from '../src/types/config';
import { decodeAlignedToken } from '../src/core/alignedToken';

let failed = 0;
function check(label: string, ok: boolean, info?: unknown): void {
  if (ok) console.log('  ok  ' + label);
  else { failed++; console.error('FAIL ' + label, info !== undefined ? JSON.stringify(info) : ''); }
}
const it = (lang: string, n: number) => ({ lang, n });

(async () => {
  // the helpers
  const mixed = [it('eng', 1), it('ron', 2), it('eng', 3), it('fra', 4), it('ron', 5)];
  check('Romanian first, then English, then what is not in the list; each keeps its own order', groupByLanguage(mixed, ['ron', 'eng']).map(x => x.n).join() === '2,5,1,3,4', groupByLanguage(mixed, ['ron', 'eng']).map(x => x.n));
  check('English first when the user wants it first', groupByLanguage(mixed, ['eng', 'ron']).map(x => x.n).join() === '1,3,2,5,4');
  check('the limit counts per language', capPerLanguage(groupByLanguage(mixed, ['ron', 'eng']), 1).map(x => x.n).join() === '2,1,4', capPerLanguage(groupByLanguage(mixed, ['ron', 'eng']), 1).map(x => x.n));
  check('no limit keeps everything', capPerLanguage(mixed, 0).length === 5);
  check('language codes written another way are understood (ro = ron)', groupByLanguage([it('eng', 1), it('ron', 2)], ['ro', 'en']).map(x => x.n).join() === '2,1');

  // the whole list: five Romanian and five English subtitles, the English ones the better ones (exact release)
  const FILE = 'Movie.2001.1080p.BluRay.x264-GRP.mkv';
  const server = http.createServer((req, res) => {
    const eng = (req.url || '').startsWith('/eng/');
    const subs = [0, 1, 2, 3, 4].map(i => ({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/dl/${eng ? 'e' : 'r'}${i}.srt`, lang: eng ? 'eng' : 'ron',
      title: eng ? `Movie.2001.1080p.BluRay.x264-GRP${i ? 'X' + i : ''}` : `Movie.2001.720p.WEB-DL.x264-OTHER${i}`
    }));
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ subtitles: subs }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const addon = (id: string) => ({ id, name: id, manifestUrl: `${base}/${id}/manifest.json`, enabled: true, selectedResources: ['subtitles'] });
  const config = (patch: Partial<UserConfig> = {}): UserConfig => ({
    ...DEFAULT_USER_CONFIG, providers: {}, languages: ['ron', 'eng'], providerTimeoutMs: 6000, deduplication: false, subsync: false,
    dynamicTimeout: false, customAddons: [addon('eng'), addon('ro')], maxSubtitles: 3, ...patch
  });
  const ask = (id: string, cfg: UserConfig) => getAggregatedSubtitles(parseSubtitleQuery('movie', id, { filename: FILE }), cfg, 'http://x');
  try {
    const r = await ask('tt0000071', config());
    const langs = r.subtitles.map(s => s.lang);
    check('with a limit of 3 there are 3 Romanian and 3 English subtitles', langs.filter(l => l === 'ron').length === 3 && langs.filter(l => l === 'eng').length === 3, langs);
    check('the Romanian ones come first (although the English ones score higher)', langs.slice(0, 3).every(l => l === 'ron'), langs);
    const noLimit = await ask('tt0000072', config({ maxSubtitles: 0 }));
    check('without a limit all ten are there, Romanian first', noLimit.subtitles.length === 10 && noLimit.subtitles.slice(0, 5).every(s => s.lang === 'ron'), noLimit.subtitles.map(s => s.lang));
    const eFirst = await ask('tt0000073', config({ languages: ['eng', 'ron'] }));
    check('with English first, English comes first', eFirst.subtitles.slice(0, 3).every(s => s.lang === 'eng'), eFirst.subtitles.map(s => s.lang));
    const oneLang = await ask('tt0000074', config({ languages: ['ron'] }));
    check('a single language: 3 of it, as before', oneLang.subtitles.length === 3 && oneLang.subtitles.every(s => s.lang === 'ron'), oneLang.subtitles.map(s => s.lang));

    // the Subsync alternatives of a subtitle are the next ones of its language, also the ones the limit does not show
    const sync = await getAggregatedSubtitles(parseSubtitleQuery('movie', 'tt0000075', { filename: FILE }),
      config({ languages: ['ron'], maxSubtitles: 2, subsync: true, customAddons: [addon('ro')] }), 'http://x', 'a0000000-0000-4000-8000-0000000000a5');
    const tokenOf = (u: string) => { const m = /\/sub\/aligned\/([^/]+)\.srt$/.exec(u); return m ? decodeAlignedToken(m[1]) : null; };
    const first = tokenOf(sync.subtitles[0]?.url || '');
    check('the list shows the 2 allowed', sync.subtitles.length === 2, sync.subtitles.length);
    check('the first subtitle carries 3 alternatives although only 2 are shown (the others come from what the limit left out)', Boolean(first && first.a && first.a.length === 3), first && first.a && first.a.length);
    check('and they are not repeated or the subtitle itself', Boolean(first && first.a && new Set([first.u, ...first.a.map(x => x.u)]).size === 4));
  } finally { server.close(); }
  if (failed) { console.error(`${failed} FAIL`); process.exit(1); }
  console.log('languageList: all ok');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
