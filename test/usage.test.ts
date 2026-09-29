import { recordUsage, getUsage } from '../src/storage/usageStore';
import { getLogLines, Logger } from '../src/utils/logger';

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok  ${name}`);
  else { failures++; console.log(`  FAIL ${name}`, detail ?? ''); }
}

async function main() {
  // No DATABASE_URL in tests: the store runs in memory
  delete process.env.DATABASE_URL;
  const key = '11111111-2222-3333-4444-555555555555';

  await recordUsage(key, { id: 'tt0111161', type: 'movie', filename: 'The.Shawshank.Redemption.1994.1080p.BluRay-GRP.mkv' });
  await recordUsage(key, { id: 'tt0944947:1:1', type: 'series' });
  await recordUsage('another-config', { id: 'tt1', type: 'movie' });

  const usage = await getUsage(key, 'Europe/Bucharest');
  check('counts only this configuration', usage.total === 2, usage.total);
  check('newest first', usage.recent[0].id === 'tt0944947:1:1', usage.recent[0]);
  check('file name kept', usage.recent[1].filename.includes('Shawshank'));
  check('histogram adds up', usage.byHour.reduce((a, b) => a + b, 0) === 2 && usage.byDayHour.flat().reduce((a, b) => a + b, 0) === 2);
  check('not persistent without database', usage.persistent === false);
  check('bad time zone falls back', (await getUsage(key, 'Not/AZone')).tz === 'Europe/Bucharest');

  const before = getLogLines(0).last;
  Logger.info('usage-test marker');
  const after = getLogLines(before);
  check('log buffer returns only new lines', after.lines.length === 1 && after.lines[0].text.includes('usage-test marker'), after);

  if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nAll usage checks passed');
}

main();
