import os from 'os';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { AddressInfo } from 'net';
import axios from 'axios';

// Keep the test isolated: never touch a real database or the project's data directory
process.env.DATABASE_URL = '';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'subs2b-vtt-'));

import { vttToSrt } from '../src/utils/subtitleFormat';
import { validateAndFormatSubtitle } from '../src/proxy/subtitleProxy';
import { createServer } from '../src/server';
import { configStorage } from '../src/storage/configStore';
import { DEFAULT_USER_CONFIG, mergeWithDefaults } from '../src/config/userConfig';
import { globalSubtitleCache } from '../src/utils/cache';
import { getAggregatedSubtitles } from '../src/core/aggregator';
import { RawSubtitleItem, SubtitleQuery } from '../src/types/provider';

let failures = 0;
function check(ok: boolean, label: string, details?: unknown): void {
  if (ok) {
    console.log(`  ✅ ${label}`);
  } else {
    failures++;
    console.error(`  ❌ FAILED: ${label}`, details !== undefined ? JSON.stringify(details) : '');
  }
}

const RICH_VTT = [
  '﻿WEBVTT - a title',
  '',
  'NOTE this is a comment',
  'over two lines',
  '',
  'STYLE',
  '::cue { color: yellow }',
  '',
  'REGION',
  'id:r1',
  '',
  'intro-cue',
  '00:01.000 --> 00:03.500 align:start position:10% line:90% size:40%',
  '<v Ion>Hello, <c.yellow>world</c>!</v>',
  '&lt;ok&gt; &amp; done&nbsp;now',
  '',
  '2',
  '00:00:04.000 --> 00:00:06.25',
  '{\\an8}<i>Italic text</i>',
  '<00:00:05.000>with a timestamp tag',
  '',
  '3',
  '00:00:07.000 --> 00:00:08.000',
  '',
  ''
].join('\r\n');

function unitTests(): void {
  console.log('--- vttToSrt ---');
  const srt = vttToSrt(RICH_VTT);
  const blocks = srt.trim().split('\n\n');
  check(blocks.length === 2, 'the empty cue is dropped and 2 cues remain', blocks);
  check(!/WEBVTT|NOTE|STYLE|REGION|::cue|id:r1/.test(srt), 'header, NOTE, STYLE and REGION blocks are removed');
  check(!/align:|position:|line:|size:/.test(srt), 'cue settings (align/position/line/size) are removed');
  check(blocks[0].startsWith('1\n00:00:01,000 --> 00:00:03,500\n'), 'timestamps without hours are converted, cue is numbered from 1', blocks[0]);
  check(blocks[0].includes('Hello, world!'), 'voice and class tags are removed but the text stays', blocks[0]);
  check(blocks[0].includes('<ok> & done now'), 'HTML entities are decoded', blocks[0]);
  check(blocks[1].startsWith('2\n00:00:04,000 --> 00:00:06,250\n'), 'short fractions are padded (06.25 -> 06,250)', blocks[1]);
  check(!srt.includes('{\\an8}') && !srt.includes('{an8}'), 'the ASS position tag {\\an8} is removed');
  check(blocks[1].includes('<i>Italic text</i>'), 'italic markup is kept', blocks[1]);
  check(!srt.includes('<00:00:05.000>') && blocks[1].includes('with a timestamp tag'), 'inline timestamp tags are removed', blocks[1]);
  check(!srt.includes('\r'), 'line endings are normalized');

  const naive = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nLinie unu\n\n2\n01:00:00.000 --> 01:00:02.500\nLinie doi\n';
  const naiveSrt = vttToSrt(naive);
  check(naiveSrt === '1\n00:00:01,000 --> 00:00:02,000\nLinie unu\n\n2\n01:00:00,000 --> 01:00:02,500\nLinie doi\n', 'a plain VTT (an SRT with a header) converts back exactly', naiveSrt);
  check(vttToSrt('WEBVTT\n\n') === '', 'a VTT without cues gives an empty result');

  console.log('\n--- validateAndFormatSubtitle with VTT ---');
  const validated = validateAndFormatSubtitle(RICH_VTT.replace('﻿', ''), 'srt');
  check(validated.valid && validated.format === 'srt', 'a VTT with hour-less timestamps is accepted', validated.reason);
  check(validated.content.startsWith('1\n00:00:01,000 --> 00:00:03,500'), 'and delivered as SRT');
}

async function integrationTests(): Promise<void> {
  console.log('\n--- HTTP: /:config/sub/convert.srt ---');

  // a tiny "addon server" that serves a VTT file and a broken endpoint
  const upstream = http.createServer((req, res) => {
    if (req.url === '/sub.vtt') {
      res.setHeader('Content-Type', 'text/vtt');
      res.end('WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000 line:80%\nHello\n');
    } else if (req.url === '/redirect.vtt') {
      res.statusCode = 302;
      res.setHeader('Location', 'http://169.254.169.254/latest/meta-data/');
      res.end();
    } else {
      res.statusCode = 500;
      res.end('boom');
    }
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const upstreamBase = `http://127.0.0.1:${upstreamPort}`;

  await configStorage.initialize();
  const uuid = 'd0000000-0000-4000-8000-0000000000d1';
  const config = mergeWithDefaults({
    customAddons: [{ id: 'mock-addon', name: 'Mock Addon', manifestUrl: `${upstreamBase}/manifest.json`, enabled: true }]
  });
  await configStorage.saveConfigAsync(uuid, 'password-123', config);

  const app = http.createServer(createServer());
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const client = axios.create({
    baseURL: `http://127.0.0.1:${(app.address() as AddressInfo).port}`,
    validateStatus: () => true,
    maxRedirects: 0
  });

  try {
    const ok = await client.get(`/${uuid}/sub/convert.srt`, { params: { url: `${upstreamBase}/sub.vtt` } });
    check(ok.status === 200, 'a VTT from an imported addon is converted (200, older ?url= link)', ok.status);

    const encodedPath = Buffer.from(`${upstreamBase}/sub.vtt`).toString('base64url');
    const viaPath = await client.get(`/${uuid}/sub/convert/${encodedPath}.srt`);
    check(viaPath.status === 200 && viaPath.data === '1\n00:00:01,000 --> 00:00:02,000\nHello', 'the same conversion works through the .srt path link', { status: viaPath.status, data: viaPath.data });
    const badPath = await client.get(`/${uuid}/sub/convert/${Buffer.from('http://example.com/sub.vtt').toString('base64url')}.srt`);
    check(badPath.status === 400, 'a forbidden host is refused through the path link too', badPath.status);
    check(String(ok.headers['content-type']).startsWith('application/x-subrip'), 'served as an SRT subtitle (application/x-subrip)', ok.headers['content-type']);
    check(ok.data === '1\n00:00:01,000 --> 00:00:02,000\nHello', 'and the body is clean SRT', ok.data);

    const blocked = await client.get(`/${uuid}/sub/convert.srt`, { params: { url: 'http://example.com/sub.vtt' } });
    check(blocked.status === 400, 'a host that is not an addon of this configuration is refused', blocked.status);

    const unknownConfig = await client.get('/d0000000-0000-4000-8000-0000000000ff/sub/convert.srt', { params: { url: `${upstreamBase}/sub.vtt` } });
    check(unknownConfig.status === 400, 'an unknown configuration is refused', unknownConfig.status);

    const failing = await client.get(`/${uuid}/sub/convert.srt`, { params: { url: `${upstreamBase}/missing.vtt` } });
    check(failing.status === 302 && failing.headers.location === `${upstreamBase}/missing.vtt`, 'when the source fails the player is sent to the original link', { status: failing.status, location: failing.headers.location });

    const redirected = await client.get(`/${uuid}/sub/convert.srt`, { params: { url: `${upstreamBase}/redirect.vtt` } });
    check(redirected.status === 302 && redirected.headers.location === `${upstreamBase}/redirect.vtt`, 'a redirect to a forbidden host is not followed', { status: redirected.status, location: redirected.headers.location });
  } finally {
    app.close();
  }

  console.log('\n--- aggregator: which links are converted ---');
  const query: SubtitleQuery = { type: 'movie', id: 'tt7000001', imdbId: 'tt7000001', season: null, episode: null, kitsuId: null };
  const items: RawSubtitleItem[] = [
    { id: 'vtt-addon', provider: 'mock-addon', providerName: 'Mock', url: `${upstreamBase}/abc/sub.vtt`, lang: 'ron', release: 'Movie.2020.1080p.WEB-DL-AAA', format: 'vtt' },
    { id: 'srt-addon', provider: 'mock-addon', providerName: 'Mock', url: `${upstreamBase}/abc/sub.srt`, lang: 'ron', release: 'Movie.2020.720p.WEB-DL-BBB', format: 'srt' },
    { id: 'vtt-foreign', provider: 'other', providerName: 'Other', url: 'https://unknown-site.example.com/x.vtt', lang: 'ron', release: 'Movie.2020.480p.WEB-DL-CCC', format: 'vtt' },
    { id: 'own', provider: 'subdl', providerName: 'SubDL', url: '/sub/proxy?url=x', lang: 'ron', release: 'Movie.2020.2160p.WEB-DL-DDD', format: 'srt' }
  ];
  const run = async (cfgPatch: Partial<typeof config>, configId: string | undefined) => {
    const cfg = { ...config, languages: ['ron'], deduplication: false, ...cfgPatch };
    const enabled = Object.keys(cfg.providers).filter(id => cfg.providers[id]?.enabled !== false);
    globalSubtitleCache.set(globalSubtitleCache.generateKey(query.id, cfg.languages, enabled, null, null), items);
    return getAggregatedSubtitles(query, cfg, 'https://addon.example', configId);
  };
  const byId = (r: { subtitles: Array<{ id: string; url: string }> }, id: string) => r.subtitles.find(s => s.id === id)?.url;

  const on = await run({}, uuid);
  check(byId(on, 'vtt-addon') === `https://addon.example/${uuid}/sub/convert/${Buffer.from(`${upstreamBase}/abc/sub.vtt`).toString('base64url')}.srt`, 'a VTT link of an imported addon goes through the converter', byId(on, 'vtt-addon'));
  check(String(byId(on, 'vtt-addon')).endsWith('.srt') && !String(byId(on, 'vtt-addon')).includes('.vtt'), 'and the converted link ends in .srt (players guess the format from the end of the link)');
  check(byId(on, 'srt-addon') === `${upstreamBase}/abc/sub.srt`, 'an SRT link is left alone', byId(on, 'srt-addon'));
  check(byId(on, 'vtt-foreign') === 'https://unknown-site.example.com/x.vtt', 'a VTT link from an unknown site is left alone', byId(on, 'vtt-foreign'));
  check(byId(on, 'own') === 'https://addon.example/sub/proxy?url=x', 'the server\'s own links are left alone', byId(on, 'own'));

  const off = await run({ convertVttToSrt: false }, uuid);
  check(byId(off, 'vtt-addon') === `${upstreamBase}/abc/sub.vtt`, 'with the setting off nothing is converted', byId(off, 'vtt-addon'));

  const noConfigId = await run({}, undefined);
  check(byId(noConfigId, 'vtt-addon') === `${upstreamBase}/abc/sub.vtt`, 'without a stored configuration nothing is converted', byId(noConfigId, 'vtt-addon'));

  check(DEFAULT_USER_CONFIG.convertVttToSrt === true, 'the conversion is on by default');
  check(mergeWithDefaults({ convertVttToSrt: false }).convertVttToSrt === false, 'the setting can be turned off');
  check(mergeWithDefaults({}).convertVttToSrt === true, 'and defaults to on for older configurations');

  upstream.close();
}

async function main(): Promise<void> {
  unitTests();
  await integrationTests();
  if (failures > 0) {
    console.error(`\n❌ ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nvttConvert OK');
  process.exit(0);
}

main().catch(err => {
  console.error('Unexpected error in the VTT conversion tests:', err);
  process.exit(1);
});
