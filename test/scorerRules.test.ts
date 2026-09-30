import { rankSubtitles, RuleFlags, groupsAlike } from '../src/utils/scorer';
import { RawSubtitleItem } from '../src/types/provider';

/**
 * Optional scoring rules, compared one by one against the baseline (rule off vs rule on).
 * Each scenario prints what the baseline puts first and what the rule puts first.
 * NOTE: these prove the rules do what they are meant to and do not break the neighbouring cases;
 * they cannot prove that the subtitle the rule prefers is really in sync (that needs real playback data).
 */

let failed = 0;
function check(label: string, ok: boolean, info?: unknown): void {
  if (ok) console.log('  ok  ' + label);
  else {
    failed++;
    console.error('FAIL ' + label, info !== undefined ? JSON.stringify(info) : '');
  }
}

const item = (release: string, provider = 'subdl'): RawSubtitleItem =>
  ({ id: provider + ':' + release, provider, providerName: provider, url: '/x', lang: 'ron', release });

function top(rule: keyof RuleFlags | null, filename: string, releases: string[], extra: { season?: number; episode?: number } = {}): string {
  // baseline = every optional rule off (whatever the defaults are); "with rule" = only that rule on
  const rules: Partial<RuleFlags> = { fuzzyGroup: false, sourceTiers: false, multiVariant: false, ...(rule ? { [rule]: true } : {}) };
  const r = rankSubtitles(releases.map(x => item(x)), { filename, rules, ...extra });
  return r.items[0].release;
}

function compare(name: string, rule: keyof RuleFlags, filename: string, releases: string[], expectedWithRule: string, extra = {}) {
  const base = top(null, filename, releases, extra);
  const withRule = top(rule, filename, releases, extra);
  console.log(`  [${name}] baseline #1: ${base}  |  with rule #1: ${withRule}${base === withRule ? '  (no change)' : '  (CHANGED)'}`);
  check(`${name}: the rule puts the expected subtitle first`, withRule === expectedWithRule, { base, withRule });
  return { base, withRule };
}

// ---------------- rule 3: fuzzy release group ----------------
console.log('Rule 3 - release group with a tracker suffix');
{
  const file = 'Movie.2020.1080p.BluRay.x264-DEMAND.mkv';
  const list = ['Movie.2020.1080p.BluRay.x264-OTHER', 'Movie.2020.1080p.BluRay.x264-DEMANDrarbg'];
  const { base } = compare('DEMAND vs DEMANDrarbg', 'fuzzyGroup', file, list, 'Movie.2020.1080p.BluRay.x264-DEMANDrarbg');
  check('baseline ignores the suffixed group (first listed wins on a tie)', base === list[0], base);

  // hazards: groups that look alike but are different teams must NOT be merged
  check('NTb and NTG are not alike', !groupsAlike('ntb', 'ntg'));
  check('short names never match by prefix (psa / psarips)', !groupsAlike('psa', 'psarips'));
  check('sparks and sparks are not "alike" (exact is handled elsewhere)', !groupsAlike('sparks', 'sparks'));
  check('a long unrelated suffix is not a tracker', !groupsAlike('flux', 'fluxxxxxxxxxxxxx'));
  const hazard = compare('NTb file, NTG and NTb subtitles', 'fuzzyGroup', 'Show.S01E01.1080p.WEB-DL.x264-NTb.mkv',
    ['Show.S01E01.1080p.WEB-DL.x264-NTG', 'Show.S01E01.1080p.WEB-DL.x264-NTb'], 'Show.S01E01.1080p.WEB-DL.x264-NTb', { season: 1, episode: 1 });
  check('the exact group still wins with the rule on', hazard.withRule.endsWith('NTb'));
}

// ---------------- rule 4: neighbouring source tiers ----------------
console.log('Rule 4 - neighbouring source tiers');
{
  const file = 'Movie.2020.1080p.BluRay.x264-AAA.mkv';
  const list = ['Movie.2020.1080p.HDTV.x264-CCC', 'Movie.2020.1080p.WEB-DL.x264-BBB'];
  compare('BluRay file: WEB-DL (neighbour) over HDTV (two tiers away)', 'sourceTiers', file, list, 'Movie.2020.1080p.WEB-DL.x264-BBB');
  // exact source and shared group must still beat any neighbour
  const exact = compare('exact source still first', 'sourceTiers', file, ['Movie.2020.1080p.WEB-DL.x264-BBB', 'Movie.2020.1080p.BluRay.x264-ZZZ'], 'Movie.2020.1080p.BluRay.x264-ZZZ');
  check('exact source unchanged by the rule', exact.base === exact.withRule);
  const group = compare('shared group beats a neighbour source', 'sourceTiers', file, ['Movie.2020.1080p.WEB-DL.x264-BBB', 'Movie.2020.1080p.HDTV.x264-AAA'], 'Movie.2020.1080p.HDTV.x264-AAA');
  check('shared group unchanged by the rule', group.base === group.withRule);
}

// ---------------- rule 5: several releases in one name ----------------
console.log('Rule 5 - names listing several releases');
{
  const file = 'Show.S02E03.720p.HDTV.x264-AAA.mkv';
  // the playing release (AAA) is the FIRST variant of the multi-release name; the name parser only sees the last group (BBB)
  const list = [
    'Show.S02E03.720p.HDTV.x264-CCC',
    'Show.S02E03.720p.HDTV.x264-AAA;Show.S02E03.720p.HDTV.x264-BBB',
    'Show.S02E03.1080p.WEB.h264-ZZZ'
  ];
  const { base } = compare('a name listing the playing release as one variant', 'multiVariant', file, list, list[1], { season: 2, episode: 3 });
  check('baseline: ties with another subtitle and only the list order decides', base === list[0], base);
  const plain = compare('plain names are not affected', 'multiVariant', file, ['Show.S02E03.720p.HDTV.x264-AAA', 'Show.S02E03.1080p.WEB.h264-ZZZ'], 'Show.S02E03.720p.HDTV.x264-AAA', { season: 2, episode: 3 });
  check('plain names give the same result with and without the rule', plain.base === plain.withRule);
}

if (failed) {
  console.error(failed + ' rule check(s) failed');
  process.exit(1);
}
console.log('All rule checks passed');
