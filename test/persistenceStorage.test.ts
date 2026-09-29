import os from 'os';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { AddressInfo } from 'net';
import axios from 'axios';

// Keep the test isolated: never touch a real database or the project's data directory
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subs2b-persist-'));
process.env.DATABASE_URL = '';
process.env.DATA_DIR = dataDir;

import { createServer } from '../src/server';
import { configStorage, isUuid } from '../src/storage/configStore';
import { DEFAULT_USER_CONFIG } from '../src/config/userConfig';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAILED: ${message}`);
    failed++;
  }
}

async function run(baseUrl: string): Promise<void> {
  const http = axios.create({ baseURL: baseUrl, validateStatus: () => true });

  console.log('--- 1. Saving and loading a configuration ---');
  const uuid1 = 'a0000000-0000-4000-8000-000000000001';
  const password1 = 'SecurePass@2026!';

  const created = await http.post('/api/config/create', {
    uuid: uuid1,
    password: password1,
    config: { ...DEFAULT_USER_CONFIG, instanceName: 'Persistent Test 1' }
  });
  assert(created.status === 200 && created.data.success === true, 'POST /api/config/create succeeds');
  assert(String(created.data.manifestUrl).includes(uuid1), 'the response contains a manifest URL with the UUID');
  assert(String(created.data.stremioUrl).startsWith('stremio://'), 'the response contains a stremio:// install link');

  const loaded = await http.post('/api/config/load', { uuid: uuid1, password: password1 });
  assert(loaded.status === 200 && loaded.data.success === true, 'POST /api/config/load authenticates');
  assert(loaded.data.config?.instanceName === 'Persistent Test 1', 'the saved preferences come back');

  const wrongPassword = await http.post('/api/config/load', { uuid: uuid1, password: 'wrong-password' });
  assert(wrongPassword.status === 401, 'a wrong password gets 401');

  const wrongOverwrite = await http.post('/api/config/save', {
    uuid: uuid1,
    password: 'wrong-password',
    config: { ...DEFAULT_USER_CONFIG, instanceName: 'Hijacked' }
  });
  assert(wrongOverwrite.status === 401, 'a configuration cannot be overwritten with a wrong password');

  console.log('\n--- 2. Updating a configuration ---');
  const updated = await http.post('/api/config/save', {
    uuid: uuid1,
    password: password1,
    config: { ...DEFAULT_USER_CONFIG, instanceName: 'Persistent Updated', maxSubtitles: 5 }
  });
  assert(updated.status === 200 && updated.data.success === true, 'POST /api/config/save updates an existing configuration');

  const manifest = await http.get(`/${uuid1}/manifest.json`);
  assert(manifest.status === 200 && manifest.data.name === 'Persistent Updated', 'the manifest reflects the saved name');
  assert(manifest.data.id === 'org.subs2b.addon', 'the manifest id is org.subs2b.addon');
  const extras = (manifest.data.resources?.[0]?.extra || []).map((e: { name: string }) => e.name);
  assert(['filename', 'videoHash', 'videoSize'].every(n => extras.includes(n)), 'the manifest asks the player for filename, videoHash and videoSize');

  const reloaded = await http.post('/api/config/load', { uuid: uuid1, password: password1 });
  assert(reloaded.data.config?.maxSubtitles === 5, 'the subtitle limit is saved and loaded');

  const uuid2 = 'a0000000-0000-4000-8000-000000000002';
  const viaApiSave = await http.post('/api/save', {
    uuid: uuid2,
    password: 'password123',
    config: { ...DEFAULT_USER_CONFIG, instanceName: 'Created via /api/save' }
  });
  assert(viaApiSave.status === 200 && viaApiSave.data.success === true, 'POST /api/save succeeds');

  const viaPut = await http.put(`/api/config/${uuid2}`, {
    password: 'password123',
    config: { ...DEFAULT_USER_CONFIG, instanceName: 'Updated via PUT' }
  });
  assert(viaPut.status === 200 && viaPut.data.success === true, 'PUT /api/config/:uuid succeeds');
  const manifestPut = await http.get(`/${uuid2}/manifest.json`);
  assert(manifestPut.data.name === 'Updated via PUT', 'the manifest reflects the change made through PUT');

  const badUuid = await http.post('/api/config/save', { uuid: 'not-a-uuid', password: 'x', config: DEFAULT_USER_CONFIG });
  assert(badUuid.status === 400, 'an invalid UUID is rejected with 400');
  const noPassword = await http.post('/api/config/save', { uuid: uuid2, password: '', config: DEFAULT_USER_CONFIG });
  assert(noPassword.status === 400, 'a missing password is rejected with 400');

  console.log('\n--- 3. Password security (bcrypt) ---');
  const raw = fs.readFileSync(path.join(dataDir, 'configurations.json'), 'utf8');
  const record = JSON.parse(raw)[uuid1];
  assert(Boolean(record), 'the record is written to the configuration file');
  assert(!raw.includes(password1), 'the plain text password never appears in the storage');
  assert(Boolean(record?.passwordHash && record.passwordHash.startsWith('$2')), 'the password is stored as a bcrypt hash');

  console.log('\n--- 4. UUID format ---');
  assert(isUuid('51c97db4-03b7-4ec2-875d-e3a755c564b9'), 'a valid UUID is accepted');
  assert(!isUuid('invalid-uuid-string'), 'a plain string is rejected');
  assert(!isUuid(''), 'an empty string is rejected');

  console.log('\n--- 5. Endpoints ---');
  const health = await http.get('/health');
  assert(health.status === 200 && health.data.addon === 'subs2b', 'GET /health identifies the addon as subs2b');

  const subtitles = await http.get(`/${uuid1}/subtitles/movie/tt0111161.json`);
  assert(subtitles.status === 200 && Array.isArray(subtitles.data.subtitles), 'the subtitles endpoint answers with a subtitles array');

  const withExtra = await http.get(`/${uuid1}/subtitles/series/tt0903747:1:1/filename=Breaking.Bad.S01E01.mkv&videoHash=0123456789abcdef.json`);
  assert(withExtra.status === 200 && Array.isArray(withExtra.data.subtitles), 'the subtitles endpoint accepts the Stremio extra arguments');

  const debugKnown = await http.get(`/${uuid1}/debug/recent.json`);
  assert(debugKnown.status === 200 && Array.isArray(debugKnown.data.entries), 'the diagnostics page works for a stored configuration');
  const debugUnknown = await http.get('/b0000000-0000-4000-8000-000000000009/debug/recent.json');
  assert(debugUnknown.status === 404, 'the diagnostics page is a 404 for an unknown UUID');

  const blocked = await http.get('/sub/proxy', { params: { url: 'http://169.254.169.254/latest/meta-data/' } });
  assert(blocked.status === 400, 'the download proxy refuses addresses outside the subtitle sites');

  const languages = await http.get('/api/languages');
  assert(languages.status === 200 && languages.data.languages.length > 10, 'GET /api/languages lists the supported languages');

  const page = await http.get('/configure');
  assert(page.status === 200 && String(page.data).includes('subs2b'), 'the configuration page is served and named subs2b');

  const unknownRoute = await http.get('/download/abc');
  assert(unknownRoute.status === 404, 'removed legacy routes answer 404');
}

async function main(): Promise<void> {
  await configStorage.initialize();
  const server = http.createServer(createServer());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }

  console.log('\n========================================');
  console.log(`PERSISTENCE TESTS: ${passed + failed}  passed: ${passed}  failed: ${failed}`);
  console.log('========================================\n');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error in the persistence tests:', err);
  process.exit(1);
});
