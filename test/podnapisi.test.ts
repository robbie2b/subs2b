import axios from 'axios';
import { parsePodnapisiXml, podnapisiItems, PodnapisiProvider } from '../src/providers/podnapisi';
import { mapWhitelistToPodnapisi } from '../src/utils/languages';
import { isAllowedDownloadUrl } from '../src/proxy/subtitleProxy';
import { mergeWithDefaults } from '../src/config/userConfig';
import { fromFileGroup, pickReferenceCandidates } from '../src/core/alignment';
import { SubtitleQuery } from '../src/types/provider';

// Podnapisi: the XML answer (as subliminal and Bazarr read it), the filters, the links

let failures = 0;
function check(ok: boolean, label: string, details?: unknown): void {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    failures++;
    console.error(`FAIL ${label}`, details !== undefined ? JSON.stringify(details) : '');
  }
}

const sub = (o: { pid: string; title?: string; year?: number; lang?: string; release?: string; s?: number; e?: number; flags?: string }) => `
  <subtitle>
    <id>${o.pid}1</id><pid>${o.pid}</pid>
    <title>${o.title ?? 'Utopia'}</title><year>${o.year ?? 2013}</year>
    <url>https://www.podnapisi.net/subtitles/x/${o.pid}</url>
    <release>${o.release ?? ''}</release>
    <language>${o.lang ?? 'ro'}</language>
    <tvSeason>${o.s ?? 1}</tvSeason><tvEpisode>${o.e ?? 2}</tvEpisode>
    <flags>${o.flags ?? ''}</flags><downloads>120</downloads><rating>8</rating>
  </subtitle>`;

const page = (current: number, count: number, subs: string) =>
  `<?xml version="1.0" encoding="utf-8"?><results><pagination><current>${current}</current><count>${count}</count><results>${count * 2}</results></pagination>${subs}</results>`;

async function main(): Promise<void> {
  console.log('Reading the answer');
  {
    const xml = page(1, 1,
      sub({ pid: 'A1', release: 'Utopia.S01E02.720p.HDTV.x264-TLA Utopia.S01E02.HDTV.x264-ORGANiC...' }) +
      sub({ pid: 'A1', release: 'duplicate' }) +
      sub({ pid: 'B2', lang: 'en', flags: 'nh', title: 'Utopia &amp; Co' }));
    const r = parsePodnapisiXml(xml);
    check(r.entries.length === 2, 'two subtitles (the repeated pid is read once)', r.entries.map(e => e.pid));
    check(r.entries[0].releases.join('|') === 'Utopia.S01E02.720p.HDTV.x264-TLA|Utopia.S01E02.HDTV.x264-ORGANiC', 'the releases are split, trailing dots removed', r.entries[0].releases);
    check(r.entries[1].hearingImpaired && r.entries[1].title === 'Utopia & Co', 'flags and entities are read', r.entries[1]);
    check(r.page === 1 && r.pages === 1, 'pagination is read');
    check(parsePodnapisiXml('<html>blocked</html>').entries.length === 0, 'a page that is not XML gives nothing (no crash)');
  }

  console.log('Keeping the right content');
  {
    const q = { id: 'tt2384811:1:2', imdbId: 'tt2384811', type: 'series', season: 1, episode: 2 } as SubtitleQuery;
    const entries = parsePodnapisiXml(page(1, 1,
      sub({ pid: 'OK', release: 'Utopia.S01E02.1080p.BluRay.x264-SHORTBREHD' }) +
      sub({ pid: 'EP', e: 3 }) +
      sub({ pid: 'OTHER', title: 'Dystopia Rising' }) +
      sub({ pid: 'NOLANG', lang: 'xx-unknown' }) +
      sub({ pid: 'NOREL' }))).entries;
    const items = podnapisiItems(entries, q, 'Utopia', 2013);
    check(items.map(i => i.id).join() === 'podnapisi-OK,podnapisi-NOREL', 'other episodes, other titles and unknown languages are dropped', items.map(i => i.id));
    check(items[0].lang === 'ron' && items[0].provider === 'podnapisi', 'the language is the 3-letter code');
    check(items[0].url.startsWith('/sub/proxy?url=') && decodeURIComponent(items[0].url).includes('https://www.podnapisi.net/subtitles/OK/download?container=zip'), 'the download goes through /sub/proxy (zip)', items[0].url);
    check(items[1].release === 'Utopia S01E02', 'without a release name: title and episode', items[1].release);
    check(isAllowedDownloadUrl('https://www.podnapisi.net/subtitles/OK/download?container=zip'), 'podnapisi.net is an allowed download host');

    const movie = { id: 'tt1', imdbId: 'tt1', type: 'movie', season: null, episode: null } as SubtitleQuery;
    const m = podnapisiItems(parsePodnapisiXml(page(1, 1, sub({ pid: 'M1', title: 'Heat', year: 1995 }) + sub({ pid: 'M2', title: 'Heat', year: 2013 }))).entries, movie, 'Heat', 1995);
    check(m.map(i => i.id).join() === 'podnapisi-M1', 'a film of another year (same title) is dropped', m.map(i => i.id));
  }

  console.log('Languages');
  check(mapWhitelistToPodnapisi(['ron']).join() === 'ro' && mapWhitelistToPodnapisi(['pob']).join() === 'pt-br', 'ron -> ro, pob -> pt-br', mapWhitelistToPodnapisi(['ron', 'pob']));

  console.log('Several releases in one name (Subsync)');
  {
    const FILE = 'Utopia.S01E02.1080p.BluRay.x264-SHORTBREHD.mkv';
    check(fromFileGroup(FILE, 'Utopia.S01E02.720p.HDTV.x264-TLA; Utopia.S01E02.1080p.BluRay.x264-SHORTBREHD'), 'trusted when one of the listed releases is the file\'s group');
    const refs = pickReferenceCandidates([
      { id: 'p1', provider: 'podnapisi', providerName: 'Podnapisi', url: '/sub/proxy?url=x', lang: 'eng', release: 'Utopia.S01E02.HDTV.x264-TLA; Utopia.S01E02.1080p.BluRay.x264-OTHER' }
    ], FILE, 1, 2);
    check(refs.length === 1, 'a reference counts when one of its releases is of the file\'s kind', refs);
  }

  console.log('Searching');
  {
    const asked: Array<Record<string, unknown>> = [];
    const realGet = axios.get;
    (axios as any).get = async (url: string, opts: { params?: Record<string, unknown> }) => {
      if (url.includes('cinemeta')) return { data: { meta: { name: 'Utopia', releaseInfo: '2013-2014' } } };
      asked.push(opts.params || {});
      const p = Number(opts.params?.page || 1);
      return { data: page(p, 5, sub({ pid: `P${p}`, release: `Utopia.S01E02.720p.HDTV.x264-G${p}` })) };
    };
    const provider = new PodnapisiProvider();
    const config = mergeWithDefaults({ languages: ['ron'], providers: { podnapisi: { enabled: true, apiKey: '' } } as any });
    const q = { id: 'tt2384811:1:2', imdbId: 'tt2384811', type: 'series', season: 1, episode: 2 } as SubtitleQuery;
    const items = await provider.search(q, { config, providerConfig: config.providers.podnapisi, timeoutMs: 5000 } as any);
    check(asked[0]?.sL === 'ro' && asked[0]?.sK === 'Utopia' && asked[0]?.sTS === 1 && asked[0]?.sTE === 2 && asked[0]?.sXML === 1, 'asks by title, language and episode', asked[0]);
    check(asked.length === 3 && items.length === 3, 'reads at most 3 pages', { pages: asked.length, items: items.length });

    asked.length = 0;
    await provider.search({ ...q, allLanguages: true }, { config, providerConfig: config.providers.podnapisi, timeoutMs: 5000 } as any);
    check(asked.length > 0 && !('sL' in asked[0]), 'the references search asks for every language (no sL)', asked[0]);
    (axios as any).get = async (url: string) => url.includes('cinemeta')
      ? { data: { meta: { name: 'Utopia', releaseInfo: '2013-2014' } } }
      : { data: '<html><title>Just a moment...</title></html>' };
    const blocked = await (provider as any).searchWithStatus(q, { config, providerConfig: config.providers.podnapisi, timeoutMs: 5000 });
    check(blocked.failed === true && /search results/.test(blocked.error || ''), 'a block page is reported as a failure, not as "nothing found"', blocked);
    (axios as any).get = realGet;
  }

  check(mergeWithDefaults({ providers: { podnapisi: { enabled: true, apiKey: '' } } as any }).providers.podnapisi.enabled === true, 'can be switched on without a key');

  if (failures) {
    console.error(`${failures} Podnapisi check(s) failed`);
    process.exit(1);
  }
  console.log('All Podnapisi checks passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
