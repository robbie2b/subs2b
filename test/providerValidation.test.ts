import os from 'os';
import path from 'path';
import fs from 'fs';
import AdmZip from 'adm-zip';
import zlib from 'zlib';
import iconv from 'iconv-lite';

// Keep the test isolated: never touch a real database or the project's data directory
process.env.DATABASE_URL = '';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'subs2b-test-'));

import { getAllProviders } from '../src/providers';
import { GenericStremioAddonProvider } from '../src/providers/genericStremioAddon';
import { validateAndNormalizeLanguage } from '../src/utils/normalizer';
import { RawSubtitleItem, SubtitleQuery } from '../src/types/provider';
import { getAggregatedSubtitles } from '../src/core/aggregator';
import { DEFAULT_USER_CONFIG, mergeWithDefaults, decodeUserConfigAsync } from '../src/config/userConfig';
import { UserConfig } from '../src/types/config';
import { globalSubtitleCache } from '../src/utils/cache';
import { configStorage, isUuid } from '../src/storage/configStore';
import {
  decompressBuffer,
  toCleanUtf8,
  validateAndFormatSubtitle,
  isAllowedDownloadUrl
} from '../src/proxy/subtitleProxy';

let failures = 0;

function check(ok: boolean, label: string, details?: unknown): void {
  if (ok) {
    console.log(`  ✅ ${label}`);
  } else {
    failures++;
    console.error(`  ❌ FAILED: ${label}`, details !== undefined ? JSON.stringify(details) : '');
  }
}

function section(title: string): void {
  console.log(`\n--- ${title} ---`);
}

/** Seeds the search cache with raw provider results, as if the providers had just answered */
function seedCache(query: SubtitleQuery, config: UserConfig, items: RawSubtitleItem[]): void {
  const enabled = Object.keys(config.providers).filter(id => config.providers[id]?.enabled !== false);
  globalSubtitleCache.set(
    globalSubtitleCache.generateKey(query.id, config.languages, enabled, query.season, query.episode),
    items
  );
}

function makeQuery(id: string, season: number, episode: number): SubtitleQuery {
  return { type: 'series', id, imdbId: id.split(':')[0], season, episode, kitsuId: null };
}

async function main(): Promise<void> {
  console.log('🧪 Running the subs2b validation suite...');

  // 1. Registered built-in providers
  section('Test 1: built-in providers');
  const providers = getAllProviders();
  const expectedIds = ['opensubtitles', 'subdl', 'subsource', 'regielive', 'podnapisi'];
  check(providers.length === expectedIds.length, `exactly ${expectedIds.length} built-in providers`, providers.map(p => p.id));
  for (const p of providers) {
    check(expectedIds.includes(p.id), `provider [${p.id}] is expected`);
    check(Boolean(p.name && p.name.trim()), `provider [${p.id}] has a name ("${p.name}")`);
    // RegieLive works with a shared key (a personal key is optional), Podnapisi needs none
    check(p.requiresApiKey === !['regielive', 'podnapisi'].includes(p.id), `provider [${p.id}] key requirement is right`);
  }

  // 2. Imported Stremio addons
  section('Test 2: generic providers imported from a manifest URL');
  const customAddons = [
    { id: 'community-subtitles', name: 'Community Subs VIP', url: 'https://subs.example.com/manifest.json' },
    { id: 'titlovi-stremio', name: 'Titlovi Official', url: 'stremio://titlovi.com/manifest.json' },
    { id: 'auto-fallback-test', name: '', url: 'https://fallback.example.com/manifest.json' }
  ];
  for (const custom of customAddons) {
    const prov = new GenericStremioAddonProvider(custom.id, custom.name, custom.url);
    check(Boolean(prov.id) && Boolean(prov.name.trim()), `imported provider [${prov.id}] -> "${prov.name}"`);
  }

  // 3. Language normalization
  section('Test 3: language normalization');
  for (const raw of ['pt-br', 'por', 'en', 'english', 'spa', 'pob', 'fre']) {
    const result = validateAndNormalizeLanguage(raw, false);
    check(result.valid && Boolean(result.normalizedLang), `"${raw}" -> "${result.normalizedLang}"`);
  }
  for (const raw of ['xxx-broken', '', 'invalid_code_123', 'unknown']) {
    check(!validateAndNormalizeLanguage(raw, false).valid, `invalid language "${raw}" is discarded`);
  }
  const unknownAllowed = validateAndNormalizeLanguage('xxx-broken', true);
  check(unknownAllowed.valid && unknownAllowed.normalizedLang === 'und', 'unknown language maps to "und" when allowed', unknownAllowed);

  // 4. Aggregation pipeline keeps the original id / url and normalizes the language
  section('Test 4: aggregation pipeline');
  {
    const query = makeQuery('tt0903747:1:1', 1, 1);
    const config: UserConfig = {
      ...DEFAULT_USER_CONFIG,
      languages: ['pob', 'eng'],
      languageRemap: { 'pt-br': 'pob', 'por': 'pob' },
      allowUnknownLanguages: false,
      deduplication: true
    };
    seedCache(query, config, [{
      id: 'sub-ext-101',
      provider: 'external-addon',
      providerName: 'External Subs Addon',
      url: 'https://subs5.strem.io/en/download/file/1952160592.srt',
      lang: 'pt-BR',
      release: 'Breaking.Bad.S01E01.720p.HDTV.x264'
    }]);

    const response = await getAggregatedSubtitles(query, config, 'http://localhost:7000');
    check(response.subtitles.length === 1, 'one subtitle in the final response', response.subtitles.length);
    const sub = response.subtitles[0];
    check(sub?.lang === 'pob', 'language normalized to "pob"', sub?.lang);
    check(sub?.id === 'sub-ext-101', 'original id preserved', sub?.id);
    check(sub?.url === 'https://subs5.strem.io/en/download/file/1952160592.srt', 'original url preserved', sub?.url);
  }

  // 5. Services default state and API key rules
  section('Test 5: services start disabled and need an API key');
  for (const id of ['opensubtitles', 'subdl', 'subsource', 'regielive', 'podnapisi']) {
    check(DEFAULT_USER_CONFIG.providers[id]?.enabled === false, `provider ${id} starts disabled`);
  }
  const mergedNoKey = mergeWithDefaults({
    providers: { opensubtitles: { enabled: true, apiKey: '' }, subdl: { enabled: true, apiKey: '   ' } }
  });
  const regie = mergeWithDefaults({ providers: { regielive: { enabled: true, apiKey: '' } } });
  check(regie.providers.regielive?.enabled === true, 'RegieLive can be enabled without a key (optional key)');
  check(
    mergedNoKey.providers.opensubtitles?.enabled === false && mergedNoKey.providers.subdl?.enabled === false,
    'a service cannot be enabled without an API key'
  );
  const mergedWithKey = mergeWithDefaults({ providers: { opensubtitles: { enabled: true, apiKey: 'valid-test-key-123' } } });
  check(mergedWithKey.providers.opensubtitles?.enabled === true, 'a service with an API key can be enabled');

  // 6. Configuration storage (UUID + bcrypt password)
  section('Test 6: UUID + password storage');
  const testUuid = '51c97db4-03b7-4ec2-875d-e3a755c564b9';
  const testPassword = 'SuperSecretPassword!@#123';
  check(isUuid(testUuid), 'isUuid recognizes a valid UUID');

  const saveRes = await configStorage.saveConfigAsync(testUuid, testPassword, {
    ...DEFAULT_USER_CONFIG,
    instanceName: 'Test Instance With UUID'
  });
  check(saveRes.success, 'configuration saved for the UUID', saveRes);

  const retrieved = await configStorage.getConfigByUuidAsync(testUuid);
  check(retrieved?.instanceName === 'Test Instance With UUID', 'getConfigByUuidAsync returns the stored configuration');

  const decoded = await decodeUserConfigAsync(testUuid);
  check(decoded.instanceName === 'Test Instance With UUID', 'decodeUserConfigAsync(uuid) resolves the stored configuration');

  const authOk = await configStorage.authenticateAndGetConfigAsync(testUuid, testPassword);
  check(authOk.success && Boolean(authOk.config), 'authentication with the right password works');

  const authFail = await configStorage.authenticateAndGetConfigAsync(testUuid, 'WrongPassword123');
  check(!authFail.success && authFail.error === 'Invalid UUID or password.', 'wrong password gets a generic error', authFail);

  const authUnknown = await configStorage.authenticateAndGetConfigAsync('00000000-0000-4000-8000-000000000000', testPassword);
  check(!authUnknown.success, 'unknown UUID is rejected');

  // 7. Language remapping across providers + joint deduplication
  section('Test 7: language remapping and joint deduplication');
  const providerLanguages = [
    { raw: 'pt-pt', expected: 'pob' },
    { raw: 'pt-br', expected: 'pob' },
    { raw: 'Portuguese (Brazil)', expected: 'pob' },
    { raw: 'Portuguese (Portugal)', expected: 'pob' },
    { raw: 'Portuguese (BR)', expected: 'pob' },
    { raw: 'Portuguese (PT)', expected: 'pob' },
    { raw: 'PT-BR', expected: 'pob' },
    { raw: 'PT-PT', expected: 'pob' },
    { raw: 'por', expected: 'pob' },
    { raw: 'pob', expected: 'pob' }
  ];
  const remapRules = { 'por': 'pob', 'pt-pt': 'pob', 'pt-br': 'pob' };
  const allRemapped = providerLanguages.every(({ raw, expected }) => {
    const res = validateAndNormalizeLanguage(raw, false, remapRules);
    return res.valid && res.normalizedLang === expected;
  });
  check(allRemapped, 'every Portuguese spelling from the providers is remapped to "pob"');

  {
    const query = makeQuery('tt4574334:1:1', 1, 1);
    const config: UserConfig = {
      ...DEFAULT_USER_CONFIG,
      providers: {
        'opensubtitles': { enabled: true, apiKey: 'test-os-key' },
        'subdl': { enabled: true, apiKey: 'test-subdl-key' },
        'subsource': { enabled: false, apiKey: '' }
      },
      languages: ['pob'],
      languageRemap: remapRules,
      deduplication: true,
      providerPriority: ['opensubtitles', 'subdl', 'community-addon']
    };
    seedCache(query, config, [
      { id: 'os-sub-1', provider: 'opensubtitles', providerName: 'OpenSubtitles', url: 'https://api.opensubtitles.com/download/sub1.srt', lang: 'pt-pt', release: 'Stranger.Things.S01E01.720p.WEBRip.x264' },
      { id: 'subdl-sub-2', provider: 'subdl', providerName: 'SubDL', url: 'https://dl.subdl.com/sub2.srt', lang: 'Portuguese (Portugal)', release: 'Stranger Things S01E01 720p WEBRip x264' },
      { id: 'subdl-sub-3', provider: 'subdl', providerName: 'SubDL', url: 'https://dl.subdl.com/sub3.srt', lang: 'Portuguese (BR)', release: 'Stranger Things S01E01 1080p NF WEBRip' },
      { id: 'addon-sub-4', provider: 'community-addon', providerName: 'Community Addon', url: 'https://example.com/sub4.srt', lang: 'por', release: 'Stranger Things S01E01 480p HDTV' }
    ]);

    const response = await getAggregatedSubtitles(query, config, 'http://localhost:7000');
    check(response.subtitles.every(s => s.lang === 'pob'), 'every final subtitle has lang "pob"');
    check(response.subtitles.length === 3, 'the duplicate between OpenSubtitles and SubDL was merged', response.subtitles.length);
    const ids = response.subtitles.map(s => s.id);
    check(ids.includes('os-sub-1') && !ids.includes('subdl-sub-2'), 'the higher priority provider kept the duplicated release', ids);
  }

  // 8. Subtitle delivery: archives, charsets and format rules
  section('Test 8: subtitle delivery (ZIP, GZIP, charsets, WEBVTT/SRT rules)');
  {
    const zip = new AdmZip();
    zip.addFile('Breaking.Bad.S01E01.720p.srt', Buffer.from('1\n00:00:01,000 --> 00:00:04,000\nCafé résumé naïve, déjà vu\n\n', 'utf8'));
    const unzipped = decompressBuffer(zip.toBuffer());
    check(Boolean(unzipped.filename?.endsWith('.srt')), 'the .srt is found inside the ZIP', unzipped.filename);
    check(toCleanUtf8(unzipped.buffer).includes('Café résumé naïve'), 'ZIP content keeps its diacritics');

    const gz = decompressBuffer(zlib.gzipSync(Buffer.from('1\n00:00:01,000 --> 00:00:04,000\nGzip subtitle', 'utf8')));
    check(toCleanUtf8(gz.buffer).includes('Gzip subtitle'), 'GZIP is decompressed');

    const hugeZip = new AdmZip();
    hugeZip.addFile('huge.srt', Buffer.alloc(11 * 1024 * 1024, 65));
    check(decompressBuffer(hugeZip.toBuffer()).filename === undefined, 'an oversized file inside an archive is ignored');

    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode('1\n00:00:01,000 --> 00:00:04,000\nUTF-16 LE text', 'utf16le')]);
    const decodedUtf16 = toCleanUtf8(utf16);
    check(decodedUtf16.includes('UTF-16 LE text') && decodedUtf16.charCodeAt(0) !== 0xfeff, 'UTF-16 LE with BOM is decoded without a leftover BOM');

    const win1252 = toCleanUtf8(iconv.encode('1\n00:00:01,000 --> 00:00:04,000\nCafé déjà vu', 'win1252'));
    check(win1252.includes('Café déjà vu'), 'legacy Windows-1252 text is recovered');

    const noBom = toCleanUtf8(Buffer.from('﻿1\n00:00:01,000 --> 00:00:04,000\nNo BOM'));
    check(noBom.charCodeAt(0) !== 0xfeff && noBom.startsWith('1'), 'UTF-8 BOM is removed');

    const srt = validateAndFormatSubtitle('00:00:01,000 --> 00:00:04,000\nNo index\n\n2\n00:00:05,000 --> 00:00:08,000\nSecond', 'srt');
    check(srt.valid && srt.content.startsWith('1\n'), '.srt output starts with cue index 1');

    const vtt = validateAndFormatSubtitle('1\n00:00:01,000 --> 00:00:04,000\nVTT without header', 'vtt');
    check(vtt.valid && vtt.content.startsWith('WEBVTT\n\n') && vtt.content.includes('00:00:01.000'), '.vtt output has the WEBVTT header and dot timestamps');

    check(!validateAndFormatSubtitle('', 'srt').valid, 'an empty payload is rejected');
    check(!validateAndFormatSubtitle('{"message": "Unauthorized", "status": 401}', 'srt').valid, 'a JSON error payload is rejected');
    check(!validateAndFormatSubtitle('<!DOCTYPE html><html><body>502 Bad Gateway</body></html>', 'srt').valid, 'an HTML error page is rejected');
  }

  // 9. Arbitrary bidirectional N:N remapping
  section('Test 9: free bidirectional language remapping');
  {
    const rules = { 'eng': 'pob', 'pt-br': 'eng', 'por': 'pob', 'spa': 'por' };
    const lang = (raw: string) => validateAndNormalizeLanguage(raw, false, rules).normalizedLang;
    check(lang('eng') === 'pob', '"eng" -> "pob"', lang('eng'));
    check(lang('pt-br') === 'eng', '"pt-br" -> "eng" (not overwritten by "eng" -> "pob")', lang('pt-br'));
    check(lang('spa') === 'por', '"spa" -> "por"', lang('spa'));
    check(lang('por') === 'pob', '"por" -> "pob"', lang('por'));
    check(lang('pt-pt') === 'pob', '"pt-pt" -> "pob"', lang('pt-pt'));
    check(lang('fra') === 'fra', 'an unmapped language stays as it is', lang('fra'));

    const merged = mergeWithDefaults({ language_remapping: { 'eng': 'pob', 'pt-br': 'eng' } });
    check(
      merged.language_remapping?.['eng'] === 'pob' && merged.languageRemap['eng'] === 'pob',
      'language_remapping and languageRemap stay in sync'
    );
  }

  // 10. Maximum number of subtitles shown to the player
  section('Test 10: subtitle limit');
  {
    const query = makeQuery('tt1000001:1:1', 1, 1);
    const items: RawSubtitleItem[] = Array.from({ length: 8 }, (_, i) => ({
      id: `limit-${i}`,
      provider: 'subdl',
      providerName: 'SubDL',
      url: `https://dl.subdl.com/limit${i}.srt`,
      lang: 'eng',
      release: `Show.Name.S01E01.${480 + i * 10}p.WEB-DL.x264-GRP${i}`
    }));

    const unlimited: UserConfig = { ...DEFAULT_USER_CONFIG, languages: ['eng'], maxSubtitles: 0 };
    seedCache(query, unlimited, items);
    const all = await getAggregatedSubtitles(query, unlimited, 'http://localhost:7000');
    check(all.subtitles.length === 8, 'limit 0 shows every subtitle', all.subtitles.length);

    const limited: UserConfig = { ...unlimited, maxSubtitles: 3 };
    seedCache(query, limited, items);
    const few = await getAggregatedSubtitles(query, limited, 'http://localhost:7000');
    check(few.subtitles.length === 3, 'limit 3 shows only 3 subtitles', few.subtitles.length);
    check(few.subtitles.every((s, i) => s.id === all.subtitles[i].id), 'the limit keeps the best-ranked subtitles');

    check(mergeWithDefaults({ maxSubtitles: -5 }).maxSubtitles === 0, 'a negative limit becomes 0');
    check(mergeWithDefaults({ maxSubtitles: 12.7 }).maxSubtitles === 13, 'the limit is rounded');
    check(mergeWithDefaults({ maxSubtitles: 99999 }).maxSubtitles === 200, 'the limit is capped');
    check(mergeWithDefaults({}).maxSubtitles === 0, 'the limit defaults to 0 (show all)');
  }

  // 11. Unique subtitle ids
  section('Test 11: unique ids');
  {
    const query = makeQuery('tt1000002:1:1', 1, 1);
    const config: UserConfig = { ...DEFAULT_USER_CONFIG, languages: ['eng'], deduplication: false };
    seedCache(query, config, [
      { id: 'same-id', provider: 'a', providerName: 'A', url: 'https://example.com/1.srt', lang: 'eng', release: 'Show.S01E01.720p.WEB-DL-AAA' },
      { id: 'same-id', provider: 'b', providerName: 'B', url: 'https://example.com/2.srt', lang: 'eng', release: 'Show.S01E01.1080p.WEB-DL-BBB' }
    ]);
    const response = await getAggregatedSubtitles(query, config, 'http://localhost:7000');
    const ids = response.subtitles.map(s => s.id);
    check(new Set(ids).size === ids.length && ids.length === 2, 'colliding ids are made unique', ids);
  }

  // 12. The generic proxy only downloads from subtitle sites
  section('Test 12: download proxy host allowlist');
  check(isAllowedDownloadUrl('https://dl.subdl.com/subtitle/123.zip'), 'SubDL is allowed');
  check(isAllowedDownloadUrl('https://api.subsource.net/api/v1/subtitles/1/download'), 'Subsource is allowed');
  check(isAllowedDownloadUrl('https://subs5.strem.io/en/download/file/1.srt'), 'strem.io mirror is allowed');
  check(isAllowedDownloadUrl('https://dl.opensubtitles.org/en/download/sub/1'), 'OpenSubtitles mirror is allowed');
  check(!isAllowedDownloadUrl('http://169.254.169.254/latest/meta-data/'), 'cloud metadata address is blocked');
  check(!isAllowedDownloadUrl('http://localhost:7000/api/health'), 'localhost is blocked');
  check(!isAllowedDownloadUrl('https://evil.example.com/subdl.com'), 'a lookalike path is blocked');
  check(!isAllowedDownloadUrl('https://notsubdl.com/file.zip'), 'a lookalike domain is blocked');
  check(!isAllowedDownloadUrl('file:///etc/passwd'), 'non-http protocols are blocked');

  // 13. Upgrading configurations saved under the old AIOsubs name
  section('Test 13: upgrade from the AIOsubs name');
  {
    const upgraded = mergeWithDefaults({ instanceName: 'AIOSubs', instanceLogo: '/assets/AIOsubs_logo_wordmark.png' });
    check(upgraded.instanceName === 'subs2b', 'the old default name becomes subs2b', upgraded.instanceName);
    check(upgraded.instanceLogo === '/assets/subs2b_logo.png', 'the old default logo path is updated', upgraded.instanceLogo);
    check(mergeWithDefaults({ instanceName: 'AIOSubs (subs2b)' }).instanceName === 'subs2b', 'a transitional name "AIOSubs (subs2b)" becomes subs2b');
    check(mergeWithDefaults({ instanceName: 'AIO Subtitles Home' }).instanceName === 'subs2b Home', 'the old name inside a custom name is replaced');
    check(mergeWithDefaults({ instanceName: 'My Own Name' }).instanceName === 'My Own Name', 'a custom name is kept');
  }

  if (failures > 0) {
    console.error(`\n❌ ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\n🎉 All checks passed!');
}

main().catch(err => {
  console.error('❌ Unexpected error in the validation suite:', err);
  process.exit(1);
});
