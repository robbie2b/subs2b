// Two profiles (two UUIDs) must not see each other's records in the Debug page: log lines, live activity, failed
// downloads and request counts are tagged with the profile whose request caused them. The database part runs only when
// TEST_DATABASE_URL is set (a local Postgres); it also checks that tables made before this change are migrated.
import os from 'os';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { AddressInfo } from 'net';
import axios from 'axios';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || '';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'subs2b-sep-'));
delete process.env.VERCEL;

import { Logger, getLogLines } from '../src/utils/logger';
import { activity, getActivity } from '../src/utils/activity';
import { noteDownloadFailure, downloadFailures } from '../src/utils/downloadJournal';
import { noteRequest, memoryRequestCounts } from '../src/utils/requestCounter';
import { runAsOwner, ownerOf, currentOwner } from '../src/utils/requestContext';
import { createServer } from '../src/server';
import { configStorage } from '../src/storage/configStore';
import { mergeWithDefaults } from '../src/config/userConfig';

let failed = 0;
function check(label: string, ok: boolean, info?: unknown): void {
  if (ok) console.log('  ok  ' + label);
  else { failed++; console.error('FAIL ' + label, info !== undefined ? JSON.stringify(info) : ''); }
}

const A = 'a0000000-0000-4000-8000-00000000000a';
const B = 'b0000000-0000-4000-8000-00000000000b';

async function unit(): Promise<void> {
  console.log('--- records are tagged with the profile ---');
  check('outside any profile there is no owner', currentOwner() === undefined);
  runAsOwner(A, () => {
    check('inside a profile the owner is its short name, not the address', currentOwner() === ownerOf(A) && !String(currentOwner()).includes('a0000000'));
    Logger.info('line of A');
    activity('search', 'film of A', 'step of A');
    noteDownloadFailure({ host: 'host-a', place: 'proxy', reason: 'failure of A', recovered: false });
    noteRequest('https://source-a.example/x');
  });
  runAsOwner(B, () => {
    Logger.info('line of B');
    activity('search', 'film of B', 'step of B');
    noteDownloadFailure({ host: 'host-b', place: 'proxy', reason: 'failure of B', recovered: false });
    noteRequest('https://source-b.example/x');
    noteRequest('https://source-b.example/x');
  });
  Logger.info('line of the server');
  activity('search', 'server film', 'step of the server');

  const oa = ownerOf(A), ob = ownerOf(B);
  const logsA = getLogLines(0, undefined, oa).lines.map(l => l.text).join('\n');
  const logsB = getLogLines(0, undefined, ob).lines.map(l => l.text).join('\n');
  check('the log of A has its lines and the server\'s, not B\'s', logsA.includes('line of A') && logsA.includes('line of the server') && !logsA.includes('line of B'));
  check('the log of B has its lines and the server\'s, not A\'s', logsB.includes('line of B') && logsB.includes('line of the server') && !logsB.includes('line of A'));
  const actA = getActivity(0, undefined, oa).events, actB = getActivity(0, undefined, ob).events;
  check('the activity of A does not have B\'s steps', actA.some(e => e.film === 'film of A') && !actA.some(e => e.film === 'film of B') && actA.some(e => e.film === 'server film'));
  check('the activity of B does not have A\'s steps', actB.some(e => e.film === 'film of B') && !actB.some(e => e.film === 'film of A'));
  check('the owner tag is not sent to the page', !actA.some(e => 'owner' in e));
  const dfA = downloadFailures(oa), dfB = downloadFailures(ob);
  check('the failed downloads of A are not shown to B', dfA.entries.some(f => f.host === 'host-a') && !dfA.entries.some(f => f.host === 'host-b') && dfB.entries.some(f => f.host === 'host-b') && !dfB.entries.some(f => f.host === 'host-a'));
  check('and the weekly totals follow', !dfA.lastWeek.some(h => h.host === 'host-b') && !dfB.lastWeek.some(h => h.host === 'host-a'));
  const rcA = memoryRequestCounts(oa), rcB = memoryRequestCounts(ob);
  check('the request counts of A and B are apart', rcA.some(r => r.host === 'source-a.example' && r.n === 1) && !rcA.some(r => r.host === 'source-b.example') && rcB.some(r => r.host === 'source-b.example' && r.n === 2) && !rcB.some(r => r.host === 'source-a.example'));
}

async function http2(): Promise<void> {
  console.log('\n--- HTTP: the Debug pages of two profiles ---');
  await configStorage.initialize();
  await configStorage.saveConfigAsync(A, 'password-aaa', mergeWithDefaults({ providers: {}, customAddons: [] }));
  await configStorage.saveConfigAsync(B, 'password-bbb', mergeWithDefaults({ providers: {}, customAddons: [] }));
  const app = http.createServer(createServer());
  await new Promise<void>(r => app.listen(0, '127.0.0.1', r));
  const client = axios.create({ baseURL: `http://127.0.0.1:${(app.address() as AddressInfo).port}`, validateStatus: () => true });
  try {
    // a play under A (a made-up id), and one under B
    await client.get(`/${A}/subtitles/movie/tt7777771/filename=Film.Only.For.A.2020.1080p.WEB-DL-GRP.mkv.json`);
    await client.get(`/${B}/subtitles/movie/tt7777772/filename=Film.Only.For.B.2021.1080p.WEB-DL-GRP.mkv.json`);
    await new Promise(r => setTimeout(r, 800)); // (with a database the steps are saved in small batches)
    const actA = JSON.stringify((await client.get(`/${A}/debug/activity.json`)).data);
    const actB = JSON.stringify((await client.get(`/${B}/debug/activity.json`)).data);
    check('A\'s Live activity shows A\'s film and not B\'s', actA.includes('Only.For.A') && !actA.includes('Only.For.B'), actA.slice(0, 200));
    check('B\'s Live activity shows B\'s film and not A\'s', actB.includes('Only.For.B') && !actB.includes('Only.For.A'), actB.slice(0, 200));
    const logA = JSON.stringify((await client.get(`/${A}/debug/logs.json`)).data);
    const logB = JSON.stringify((await client.get(`/${B}/debug/logs.json`)).data);
    check('neither log mentions the other\'s content', !logA.includes('tt7777772') && !logB.includes('tt7777771'));
    check('neither page ever contains the other\'s address', !actA.includes(B) && !actB.includes(A) && !logA.includes(B) && !logB.includes(A));
    const rqA = (await client.get(`/${A}/debug/requests.json`)).data, rqB = (await client.get(`/${B}/debug/requests.json`)).data;
    check('the request counts answer for the profile that asks', JSON.stringify(rqA) !== JSON.stringify(rqB) || (rqA.days.length === 0 && rqB.days.length === 0), { rqA, rqB });
  } finally {
    app.close();
  }
}

async function database(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) { console.log('\n  (no TEST_DATABASE_URL: database checks skipped)'); return; }
  console.log('\n--- database: old tables are migrated, rows are kept apart ---');
  const { Pool } = await import('pg');
  const raw = new Pool({ connectionString: url });
  // tables as they were before this change, with rows that mixed every profile
  await raw.query('DROP TABLE IF EXISTS activity_events, download_failures, request_counts');
  await raw.query(`CREATE TABLE activity_events (id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL, instance TEXT NOT NULL, kind TEXT NOT NULL, film TEXT NOT NULL, text TEXT NOT NULL, meta JSONB)`);
  await raw.query(`INSERT INTO activity_events (at, instance, kind, film, text) VALUES (NOW(), 'x', 'search', 'old mixed film', 'old')`);
  await raw.query(`CREATE TABLE download_failures (id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), host TEXT NOT NULL, place TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', recovered BOOLEAN NOT NULL DEFAULT FALSE, release TEXT)`);
  await raw.query(`INSERT INTO download_failures (host, place) VALUES ('old-mixed-host', 'proxy')`);
  await raw.query(`CREATE TABLE request_counts (day DATE NOT NULL, host TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, host))`);
  await raw.query(`INSERT INTO request_counts VALUES (CURRENT_DATE, 'old-mixed.example', 9)`);

  const { persistActivity, readStoredActivity } = await import('../src/storage/activityStore');
  const { saveRequestCounts, readRequestCounts } = await import('../src/storage/requestCountStore');
  const { startDownloadFailureStore } = await import('../src/storage/downloadFailureStore');
  const oa = ownerOf(A), ob = ownerOf(B);
  persistActivity({ seq: 1, at: new Date().toISOString(), kind: 'search', film: 'db film A', text: 'a', owner: oa });
  persistActivity({ seq: 2, at: new Date().toISOString(), kind: 'search', film: 'db film B', text: 'b', owner: ob });
  persistActivity({ seq: 3, at: new Date().toISOString(), kind: 'search', film: 'db server film', text: 's' });
  await new Promise(r => setTimeout(r, 800));
  const rA = JSON.stringify(await readStoredActivity(0, oa)), rB = JSON.stringify(await readStoredActivity(0, ob));
  check('the saved activity of A has A\'s and the server\'s steps, not B\'s, and nothing of the old mixed rows', rA.includes('db film A') && rA.includes('db server film') && !rA.includes('db film B') && !rA.includes('old mixed film'), rA);
  check('the saved activity of B likewise', rB.includes('db film B') && !rB.includes('db film A'), rB);
  saveRequestCounts([{ day: new Date().toISOString().slice(0, 10), host: 'h.example', n: 3, owner: oa }, { day: new Date().toISOString().slice(0, 10), host: 'h.example', n: 5, owner: ob }]);
  await new Promise(r => setTimeout(r, 800));
  const cA = await readRequestCounts(2, oa), cB = await readRequestCounts(2, ob);
  check('the saved request counts are per profile (same host, same day: 3 and 5), and the old mixed totals are gone', cA!.length === 1 && cA![0].n === 3 && cB!.length === 1 && cB![0].n === 5, { cA, cB });
  await startDownloadFailureStore();
  const left = (await raw.query('SELECT host FROM download_failures')).rows.map(r => r.host);
  check('the old mixed download failures were dropped on migration', !left.includes('old-mixed-host'), left);
  await raw.end();
}

(async () => {
  await unit();
  await database(); // (before anything uses the tables: it makes them in their old shape first)
  await http2();
  if (failed) { console.error(`${failed} FAIL`); process.exit(1); }
  console.log('profileSeparation: all ok');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
