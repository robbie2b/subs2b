// Subsync results kept in the database with a size budget: the least recently used go first.
// The database part runs only when TEST_DATABASE_URL is set (a local Postgres); the packing always runs.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || '';
delete process.env.VERCEL;

import { packAligned, unpackAligned, loadAligned, storeAligned, trimAligned, versionedKey, ALIGN_ENGINE_VERSION, claimWork, releaseWork, waitForOther } from '../src/storage/alignedStore';
import { configStorage } from '../src/storage/configStore';

let failed = 0;
function check(label: string, ok: boolean, info?: unknown): void {
  if (ok) console.log('  ok  ' + label);
  else { failed++; console.error('FAIL ' + label, info !== undefined ? JSON.stringify(info) : ''); }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main(): Promise<void> {
  const value = { original: '1\n00:00:01,000 --> 00:00:02,000\nHello ăâî\n', served: { result: { decision: { apply: true, offset: -1.5 } }, replacedBy: 'x' } };
  check('packing keeps the text and the decision', JSON.stringify(unpackAligned(packAligned(value))) === JSON.stringify(value));

  const none = await loadAligned('nothing|here');
  check('without a database nothing is found (and nothing throws)', none === null || !process.env.DATABASE_URL);

  if (!process.env.DATABASE_URL) { console.log('  (no TEST_DATABASE_URL: database checks skipped)'); return; }
  const pool = (await configStorage.getPool())!;
  await loadAligned('warm|up', 3000); // creates the table on first use
  await pool.query('DELETE FROM aligned_cache');
  const big = (n: number) => ({ original: String(n).repeat(1) + 'x'.repeat(20000) + Math.random(), served: { result: { n } } });

  storeAligned('film|1', big(1));
  await sleep(500);
  const got = await loadAligned('film|1', 2000);
  check('a stored result comes back', !!got && (got.served.result as { n: number }).n === 1, got && got.served);

  // a decision made by an earlier version of the alignment logic is not used
  await pool.query('INSERT INTO aligned_cache (cache_key, bytes, data) VALUES ($1, $2, $3)', [versionedKey('old|logic', ALIGN_ENGINE_VERSION - 1), 10, packAligned(big(9))]);
  check('a decision of another version of the logic is not found', (await loadAligned('old|logic', 2000)) === null);
  storeAligned('old|logic', big(8));
  await sleep(500);
  const renewed = await loadAligned('old|logic', 2000);
  check('the same link decided again by the current logic is kept and found', !!renewed && (renewed.served.result as { n: number }).n === 8, renewed && renewed.served);
  await pool.query('DELETE FROM aligned_cache WHERE cache_key = $1', [versionedKey('old|logic')]);

  // fill past a small budget; film|1 is used again so it must survive, the unused oldest must go
  for (let i = 2; i <= 6; i++) { storeAligned(`film|${i}`, big(i)); await sleep(120); }
  await sleep(300);
  for (let i = 2; i <= 6; i++) await pool.query(`UPDATE aligned_cache SET last_used = NOW() - (INTERVAL '1 day' * $2::int) WHERE cache_key = $1`, [versionedKey(`film|${i}`), 10 - i]);
  await pool.query(`UPDATE aligned_cache SET last_used = NOW() WHERE cache_key = '${versionedKey('film|1')}'`);
  const before = Number((await pool.query('SELECT COUNT(*)::int n, SUM(bytes)::int b FROM aligned_cache')).rows[0].n);
  const sizes = (await pool.query('SELECT SUM(bytes)::int b FROM aligned_cache')).rows[0].b as number;
  const deleted = await trimAligned(Math.floor(sizes / 2));
  const left = (await pool.query('SELECT cache_key FROM aligned_cache ORDER BY cache_key')).rows.map(r => r.cache_key as string);
  check('over budget: some were deleted', deleted > 0 && left.length === before - deleted, { before, deleted, left });
  check('the recently used one stays', left.includes(versionedKey('film|1')), left);
  check('the least recently used go first', !left.includes(versionedKey('film|2')) && !left.includes(versionedKey('film|3')), left);
  const total = Number((await pool.query('SELECT SUM(bytes)::bigint n FROM aligned_cache')).rows[0].n);
  check('the total is under the budget after trimming', total <= sizes / 2, { total, sizes });
  check('under budget nothing is deleted', (await trimAligned(sizes * 10)) === 0);

  // "work in progress" marker between instances
  check('the first to ask gets the work', (await claimWork('work|1', 2000)) === true);
  check('the second one is told another instance is at it', (await claimWork('work|1', 2000)) === false);
  const waiter = waitForOther('work|1', 5000, 100);
  await sleep(300);
  storeAligned('work|1', { original: 'T', served: { result: { n: 42 } } });
  const gotOther = await waiter;
  check('the waiter gets the stored result', !!gotOther && (gotOther.served.result as { n: number }).n === 42, gotOther);
  check('the marker is gone once the result is stored', (await claimWork('work|1', 2000)) === true);
  releaseWork('work|1');
  await sleep(300);
  check('after a release (work ended without a result) the link can be claimed again', (await claimWork('work|1', 2000)) === true);
  const startedAt = Date.now();
  releaseWork('work|2');
  await claimWork('work|2', 2000);
  const w2 = waitForOther('work|2', 5000, 100);
  await sleep(250);
  releaseWork('work|2');
  check('a waiter whose other instance ends with no result stops waiting at once (and gets nothing)', (await w2) === null && Date.now() - startedAt < 3000);
  // a marker of a dead instance expires
  await pool.query(`UPDATE aligned_cache SET created_at = NOW() - INTERVAL '60 seconds' WHERE cache_key LIKE 'w|%'`);
  await claimWork('work|3', 2000);
  await pool.query(`UPDATE aligned_cache SET created_at = NOW() - INTERVAL '60 seconds' WHERE cache_key LIKE 'w|%'`);
  check('an old marker (a dead instance) does not block anybody', (await claimWork('work|3', 2000)) === true);

  await pool.query('DROP TABLE aligned_cache');
}

main().then(() => { if (failed) { console.error(`${failed} FAIL`); process.exit(1); } console.log('alignedStore: all ok'); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });
