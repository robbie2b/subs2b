import { executeParallelSearch } from '../src/providers';
import { OpenSubtitlesProvider } from '../src/providers/openSubtitles';
import { GenericStremioAddonProvider } from '../src/providers/genericStremioAddon';
import { mergeWithDefaults } from '../src/config/userConfig';
import { RawSubtitleItem, SubtitleQuery } from '../src/types/provider';

const query: SubtitleQuery = { type: 'movie', id: 'tt0000001', imdbId: 'tt0000001', season: null, episode: null, kitsuId: null };

function fake(provider: string, release: string): RawSubtitleItem {
  return { id: provider + '-1', provider, providerName: provider, url: '/x', lang: 'ron', release };
}

let directBehaviour: 'ok' | 'fail' | 'empty' = 'ok';
let addonCalls = 0;

// Replace the network calls with controllable fakes
(OpenSubtitlesProvider.prototype as unknown as { executeSearch: () => Promise<RawSubtitleItem[]> }).executeSearch = async () => {
  if (directBehaviour === 'fail') throw new Error('simulated OpenSubtitles outage');
  if (directBehaviour === 'empty') return [];
  return [fake('opensubtitles', 'Direct.Release')];
};
(GenericStremioAddonProvider.prototype as unknown as { executeSearch: () => Promise<RawSubtitleItem[]> }).executeSearch = async function (this: { id: string }) {
  addonCalls++;
  return [fake(this.id, 'Addon.Release')];
};

function configWith(directEnabled: boolean) {
  return mergeWithDefaults({
    providers: { opensubtitles: { enabled: directEnabled, apiKey: directEnabled ? 'some-test-key-1234' : '' } },
    customAddons: [
      { id: 'community.opensubtitlesv3.pro', name: 'opensubtitles PRO', manifestUrl: 'https://addon.example/manifest.json', enabled: true }
    ]
  });
}

let failed = 0;
function check(label: string, ok: boolean, info?: unknown): void {
  if (!ok) {
    failed++;
    console.error('FAIL', label, info !== undefined ? JSON.stringify(info) : '');
  }
}

async function main(): Promise<void> {
  // 1. direct integration fails -> the addon is used as fallback
  directBehaviour = 'fail';
  addonCalls = 0;
  let res = await executeParallelSearch(query, configWith(true));
  check('fallback used when direct fails', addonCalls === 1 && res.some(r => r.release === 'Addon.Release'), { addonCalls, res });

  // 2. direct integration works -> the addon is NOT called at all
  directBehaviour = 'ok';
  addonCalls = 0;
  res = await executeParallelSearch(query, configWith(true));
  check('addon not called when direct works', addonCalls === 0, { addonCalls });
  check('direct results returned', res.length === 1 && res[0].release === 'Direct.Release', res);

  // 3. direct returns an empty list (not an error) -> not a failure, addon stays unused
  directBehaviour = 'empty';
  addonCalls = 0;
  res = await executeParallelSearch(query, configWith(true));
  check('empty result is not treated as failure', addonCalls === 0 && res.length === 0, { addonCalls, res });

  // 4. direct integration not enabled -> the addon works as a normal provider
  directBehaviour = 'ok';
  addonCalls = 0;
  res = await executeParallelSearch(query, configWith(false));
  check('addon works normally without direct integration', addonCalls === 1 && res.some(r => r.release === 'Addon.Release'), { addonCalls, res });

  if (failed) {
    console.error(failed + ' fallback check(s) failed');
    process.exit(1);
  }
  console.log('fallback OK');
}

main();
