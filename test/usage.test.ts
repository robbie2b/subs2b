import { recordUsage, getUsage, computeProviderStats } from '../src/storage/usageStore';
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

  await recordUsage(key, { id: 'tt5', type: 'movie', filename: 'x.mkv', details: { rawTotal: 3, rawByProvider: { subsro: 3 }, afterLanguage: 3, afterDedup: 3, afterScoring: 3, shown: 2, usedFilename: true, scoringFallback: false, top: [] } });
  const withDetails = (await getUsage(key)).recent[0];
  check('ranking details are kept with the request', withDetails.details?.shown === 2, withDetails);

  const usage = await getUsage(key, 'Europe/Bucharest');
  check('counts only this configuration', usage.total === 3, usage.total);
  check('newest first', usage.recent[1].id === 'tt0944947:1:1', usage.recent[1]);
  check('file name kept', usage.recent[2].filename.includes('Shawshank'));
  check('histogram adds up', usage.byHour.reduce((a, b) => a + b, 0) === 3 && usage.byDayHour.flat().reduce((a, b) => a + b, 0) === 3);
  check('not persistent without database', usage.persistent === false);
  check('bad time zone falls back', (await getUsage(key, 'Not/AZone')).tz === 'Europe/Bucharest');

  const before = getLogLines(0).last;
  Logger.info('usage-test marker');
  const after = getLogLines(before);
  check('log buffer returns only new lines', after.lines.length === 1 && after.lines[0].text.includes('usage-test marker'), after);

  // Provider statistics: two requests, subsro wins one, opensubtitles wins the other and fails once
  const mk = (over: object) => ({ rawTotal: 5, rawByProvider: {}, afterLanguage: 5, afterDedup: 5, afterScoring: 5, shown: 2, usedFilename: true, scoringFallback: false, ...over });
  const stats = computeProviderStats([
    { at: "2026-09-30T10:00:00Z", id: "a", type: "movie", filename: "", details: mk({
      providers: [{ id: "subsro", name: "Subs.ro", ms: 400, ok: true, count: 3 }, { id: "opensubtitles", name: "OpenSubtitles", ms: 1200, ok: false, count: 0, error: "timeout" }],
      top: [{ rank: 1, score: 90, rejected: false, provider: "subsro", release: "x", reasons: [] }, { rank: 2, score: 50, rejected: false, provider: "subsro", release: "y", reasons: [] }] }) },
    { at: "2026-09-30T09:00:00Z", id: "b", type: "movie", filename: "", details: mk({
      providers: [{ id: "subsro", name: "Subs.ro", ms: 600, ok: true, count: 0 }, { id: "opensubtitles", name: "OpenSubtitles", ms: 800, ok: true, count: 4 }],
      top: [{ rank: 1, score: 250, rejected: false, provider: "opensubtitles", release: "z", reasons: ["hash match +200"] }, { rank: 2, score: 40, rejected: true, provider: "subsro", release: "w", reasons: [] }] }) },
    { at: "2026-09-30T08:00:00Z", id: "c", type: "movie", filename: "", details: mk({ cached: true, top: [{ rank: 1, score: 70, rejected: false, provider: "subsro", release: "q", reasons: [] }] }) }
  ]);
  const ro = stats.providers.find(p => p.id === "subsro")!;
  const os = stats.providers.find(p => p.id === "opensubtitles")!;
  check("stats: searches exclude cached answers", ro.searches === 2 && os.searches === 2, [ro, os]);
  check("stats: average and median time", ro.avgMs === 500 && ro.medianMs === 500 && os.maxMs === 1200);
  check("stats: success rate and last status", os.successRate === 0.5 && os.lastOk === false && os.lastError === "timeout" && ro.lastOk === true);
  check("stats: wins and top presence", ro.wins === 2 && os.wins === 1 && stats.withRanking === 3, stats);
  check("stats: rejected subtitles are not counted as in top", ro.inTop === 2, ro.inTop);
  check("stats: hash matches counted", os.hashMatches === 1);
  check("stats: empty answers are not failures", ro.emptyRate === 0.5 && ro.failures === 0);

  if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nAll usage checks passed');
}

main();
