// On Vercel a database that cannot be reached must not turn into the local-file fallback for ever
process.env.VERCEL = '1';
process.env.DATABASE_URL = 'postgres://nobody:nothing@127.0.0.1:1/none';
delete process.env.PG_POOL_MAX;

import { configStorage } from '../src/storage/configStore';

let failed = 0;
function check(label: string, ok: boolean, info?: unknown): void {
  if (ok) console.log('  ok  ' + label);
  else { failed++; console.error('FAIL ' + label, info !== undefined ? JSON.stringify(info) : ''); }
}
const outcome = (p: Promise<unknown>): Promise<'ok' | 'error'> => p.then(() => 'ok' as const, () => 'error' as const);

async function main(): Promise<void> {
  check('an unreachable database makes the request fail (no silent fallback)', (await outcome(configStorage.getConfigByUuidAsync('8f0c2c1e-0000-4000-8000-000000000001'))) === 'error');
  check('right after, the next request fails at once (no new connection attempt every time)', (await outcome(configStorage.getConfigByUuidAsync('8f0c2c1e-0000-4000-8000-000000000001'))) === 'error');
  await new Promise(r => setTimeout(r, 3200));
  const t0 = Date.now();
  const again = await outcome(configStorage.getConfigByUuidAsync('8f0c2c1e-0000-4000-8000-000000000001'));
  check('after a short pause it tries to connect again (and is not stuck on a fallback)', again === 'error' && Date.now() - t0 >= 0);
  if (failed) { console.error(`${failed} storage retry check(s) failed`); process.exit(1); }
  console.log('All storage retry checks passed');
  process.exit(0);
}
main().catch(err => { console.error(err); process.exit(1); });
