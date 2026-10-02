import { alignToReference, applyAlignment, decide, isNonDialogue, speechFlags, TimedCue, RefAlignment, withoutLoneEdges } from '../src/utils/subsync';
import { readCues, retimeSubtitle } from '../src/utils/subtitleCues';

let failed = 0;
function check(label: string, ok: boolean, info?: unknown): void {
  if (ok) console.log('  ok  ' + label);
  else {
    failed++;
    console.error('FAIL ' + label, info !== undefined ? JSON.stringify(info) : '');
  }
}

function makeBase(seed = 7, count = 600): TimedCue[] {
  let x = seed;
  const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
  const cues: TimedCue[] = [];
  let t = 4;
  for (let i = 0; i < count; i++) {
    const dur = 1 + rnd() * 3;
    cues.push({ start: t, end: t + dur, text: 'line ' + i });
    t += dur + 0.4 + rnd() * 6;
  }
  return cues;
}
const moved = (cues: TimedCue[], f: (t: number) => number, k = 1): TimedCue[] =>
  cues.map(c => ({ ...c, start: c.start * k + f(c.start), end: c.end * k + f(c.start) }));
const worst = (a: TimedCue[], b: TimedCue[], r: { ratio: number; offsets: number[] }) =>
  Math.max(...a.map((c, i) => Math.abs(c.start * r.ratio + r.offsets[i] - b[i].start)));

const BASE = makeBase();

// ---- what counts as dialogue ----
check('sound descriptions are not dialogue', isNonDialogue('[door slams]', false) && isNonDialogue('(sighs)', false) && isNonDialogue('♪ ♪', false) && isNonDialogue('', false));
check('words are dialogue', !isNonDialogue('Hello there', false) && !isNonDialogue('[Mark] Hello', false));
check('credit lines at the edges are skipped', isNonDialogue('Subtitles by English team', true) && isNonDialogue('Ripped - by X', true) && !isNonDialogue('Subtitles by English team', false));
check('markup tags do not make a cue "dialogue"', isNonDialogue('<i>[music]</i>', false) && !isNonDialogue('<i>Hello</i>', false));
check('speechFlags follows the same rule', JSON.stringify(speechFlags([{ start: 0, end: 1, text: 'Hi' }, { start: 2, end: 3, text: '[music]' }, { start: 4, end: 5, text: 'Bye' }])) === '[true,false,true]');

// ---- one constant shift ----
{
  const cand = moved(BASE, () => 5);
  const r = alignToReference(cand, BASE)!;
  check('a subtitle 5 s late: shifted back by 5 s (sign check), ratio 1', Math.abs(r.offsets[100] - -5) < 0.03 && r.ratio === 1, r.offsets[100]);
  check('...to within 30 ms everywhere', worst(cand, BASE, r) < 0.03, worst(cand, BASE, r));
  check('...in one piece, nearly all dialogue overlaps', r.segments.length === 1 && r.overlap > 0.97, { seg: r.segments.length, ov: r.overlap });
  const early = alignToReference(moved(BASE, () => -3.37), BASE)!;
  check('a subtitle 3.37 s early: +3.37 s with 10 ms precision', Math.abs(early.offsets[10] - 3.37) < 0.02, early.offsets[10]);
  const none = alignToReference(BASE, BASE)!;
  check('an aligned subtitle gets no shift', none.segments.length === 1 && Math.abs(none.offsets[0]) < 0.02 && none.ratio === 1);
}

// ---- different languages / translations: some cues missing or split, still the same timeline ----
{
  const other = moved(BASE.filter((_, i) => i % 9 !== 0), () => 5).map(c => ({ ...c, start: c.start + (Math.random() - 0.5) * 0.15 }));
  const r = alignToReference(other, BASE)!;
  const mid = r.offsets[Math.floor(other.length / 2)];
  check('missing cues and jitter do not break it', Math.abs(mid - -5) < 0.15, mid);
}

// ---- 24 / 23.976 with a reference whose length misleads (Gone Baby Gone) ----
{
  // the subtitle runs 0.1 % slow and 4 s late; the reference ends with a translator's note 250 s after the film
  const cand = moved(BASE, () => 4, 24 / 23.976);
  const last = BASE[BASE.length - 1].end;
  const ref = [...BASE, { start: last + 250, end: last + 253, text: 'Translated by someone' }];
  const r = alignToReference(cand, ref, { split: false, topRatios: 1 })!;
  check('the ratio next to 1 is tried even when the lengths suggest otherwise', Math.abs(r.ratio - 23.976 / 24) < 0.0001 && r.overlap > 0.95, { ratio: r.ratio, overlap: r.overlap });
}

// ---- 25 fps subtitle with a credit line long after the end: the guess without lone lines still finds the ratio ----
{
  const cand = BASE.map(c => ({ ...c, start: c.start * 23.976 / 25 + 2, end: c.end * 23.976 / 25 + 2 }));
  const last = cand[cand.length - 1].end;
  cand.push({ start: last + 300, end: last + 303, text: 'Subtitrare: cineva' });
  const r = alignToReference(cand, BASE, { split: false, topRatios: 1 })!;
  check('a credit line after the end does not hide the 25 fps ratio', Math.abs(r.ratio - 25 / 23.976) < 0.0005 && r.overlap > 0.95, { ratio: r.ratio, overlap: r.overlap });
  const stamp = (t: number) => new Date(Math.round(t * 1000)).toISOString().slice(11, 23).replace('.', ',');
  const srt = cand.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n');
  const out = readCues(applyAlignment(srt, r));
  const note = out.find(c => c.text === 'Subtitrare: cineva');
  check('...and the credit line is still in the subtitle, moved like the rest', out.length === cand.length && !!note
    && Math.abs(note.start - ((last + 300) * r.ratio + r.offsets[r.offsets.length - 1])) < 0.01, note);
}
{
  const iv = [{ start: 0, end: 2 }, ...Array.from({ length: 50 }, (_, i) => ({ start: 300 + i * 5, end: 302 + i * 5 })), { start: 900, end: 903 }];
  const kept = withoutLoneEdges(iv);
  check('lone lines at both ends are left out of the length guess only', kept.length === 50 && kept[0].start === 300 && iv.length === 52, kept.length);
  const dense = Array.from({ length: 60 }, (_, i) => ({ start: i * 5, end: i * 5 + 2 }));
  check('a normal subtitle keeps every line', withoutLoneEdges(dense).length === 60);
}

// ---- frame rate: 25 fps against 23.976 fps ----
{
  const cand = moved(BASE, () => 0, 23.976 / 25);          // the 25 fps version is shorter
  const r = alignToReference(cand, BASE)!;
  check('a 25 fps subtitle is stretched back (ratio 25/23.976)', Math.abs(r.ratio - 25 / 23.976) < 0.0005, r.ratio);
  check('...and lines up within 100 ms', worst(cand, BASE, r) < 0.1, worst(cand, BASE, r));
  const withOffset = moved(BASE, () => 5.84, 23.976 / 25);
  const r2 = alignToReference(withOffset, BASE)!;
  check('stretch plus a constant shift (as measured on House of the Dragon)', Math.abs(r2.ratio - 25 / 23.976) < 0.0005 && worst(withOffset, BASE, r2) < 0.15, { ratio: r2.ratio, worst: worst(withOffset, BASE, r2) });
  const small = alignToReference(moved(BASE, () => 0, 1.001), BASE)!;
  check('a 0.1 % drift (24 vs 23.976 fps) is corrected', Math.abs(small.ratio - 1 / 1.001) < 0.0006 || Math.abs(small.ratio - 23.976 / 24) < 0.0006, small.ratio);
}

// ---- a shift that changes in the middle (a cut, a different edit) ----
{
  const cutAt = BASE[300].start;
  const cand = moved(BASE, t => (t < cutAt ? 3 : 9));
  const split = alignToReference(cand, BASE)!;
  check('the change in the middle is followed: two parts', split.segments.length === 2, split.segments);
  check('...-3 s before the cut and -9 s after', Math.abs(split.offsets[50] - -3) < 0.05 && Math.abs(split.offsets[500] - -9) < 0.05, [split.offsets[50], split.offsets[500]]);
  check('...within 50 ms everywhere', worst(cand, BASE, split) < 0.05, worst(cand, BASE, split));
  const single = alignToReference(cand, BASE, { split: false })!;
  check('a single shift cannot do that (worse by seconds)', worst(cand, BASE, single) > 2, worst(cand, BASE, single));
  const stable = alignToReference(moved(BASE, () => 5), BASE)!;
  check('without a change there is no split', stable.segments.length === 1);
}

// ---- unrelated timelines ----
{
  const unrelated = alignToReference(makeBase(99), BASE)!;
  check('a timeline of another episode overlaps poorly', unrelated.overlap < 0.8, unrelated.overlap);
}

// ---- the decision from several references ----
{
  const cand = moved(BASE, () => 5);
  const mk = (label: string, ref: TimedCue[]): RefAlignment => ({ label, result: alignToReference(cand, ref)! });
  const refA = BASE;
  const refB = moved(BASE, () => 0.05).filter((_, i) => i % 7 !== 3);
  const good = decide(cand, [mk('A', refA), mk('B', refB)]);
  check('two references that agree: retime', good.apply && Math.abs(good.offset - -5) < 0.1 && good.segments === 1, good);

  const weird = mk('X', makeBase(31));
  const mixed = decide(cand, [mk('A', refA), mk('B', refB), weird]);
  check('a reference that does not fit is ignored when two agree', mixed.apply, mixed);

  // two references on different timelines (disagree) -> nothing
  const refOther = moved(BASE, t => (t < 1000 ? 20 : 11));
  const clash = decide(cand, [mk('A', refA), mk('O', refOther)]);
  check('references that disagree: nothing is changed', !clash.apply, clash);

  const single = decide(cand, [mk('A', refA)]);
  check('one reference that fits very well: retime', single.apply && single.confidence >= 0.85, single);

  const identical: RefAlignment[] = [{ label: 'A', result: alignToReference(BASE, BASE)! }, { label: 'B', result: alignToReference(BASE, refB)! }];
  const already = decide(BASE, identical);
  check('already aligned is reported as such', !already.apply && already.reason === 'already aligned', already);

  check('no references: nothing', !decide(cand, []).apply);

  const absurd: RefAlignment = { label: 'Z', result: { ...alignToReference(cand, refA)!, ratio: 1.5 } };
  check('an absurd frame-rate ratio is refused', !decide(cand, [absurd, absurd]).apply);
}

// ---- writing the retimed subtitle ----
{
  const srt = '1\n00:00:10,000 --> 00:00:12,500\nHello\nworld\n\n2\n00:01:00,000 --> 00:01:02,000\nBye\n\n3\n00:00:03,000 --> 00:00:04,000\nEarly\n';
  const cues = readCues(srt);
  check('cues are read with their text', cues.length === 3 && cues[0].text === 'Hello\nworld' && cues[1].start === 60);
  const out = applyAlignment(srt, { ratio: 1, offsets: [-4.6, -4.6, -4.6], segments: [], overlap: 1, globalScore: 1 });
  check('times move, text is kept, a cue that ends before 0 is dropped and the rest renumbered', out.includes('00:00:05,400 --> 00:00:07,900\nHello\nworld') && out.includes('2\n00:00:55,400 --> 00:00:57,400\nBye') && !out.includes('Early'), out);
  const stretched = retimeSubtitle('1\n00:01:00,000 --> 00:01:02,000\nx\n', (_i, s, e) => [s * 1.04271 + 1, e * 1.04271 + 1]);
  check('a stretch is applied to both ends of a cue', stretched.includes('00:01:03,563 --> 00:01:05,648'), stretched);
}

// ---- speed ----
{
  const cand = moved(BASE, () => 5);
  const t0 = Date.now();
  alignToReference(cand, BASE, { split: false });
  const t1 = Date.now();
  alignToReference(cand, BASE, { split: true });
  const t2 = Date.now();
  check('speed: one global alignment (600 cues) under 500 ms, with splits under 1.5 s (this machine)', t1 - t0 < 500 && t2 - t1 < 1500, { global: t1 - t0, split: t2 - t1 });
  console.log(`      (global ${t1 - t0} ms, with split ${t2 - t1} ms)`);
}

if (failed) {
  console.error(failed + ' engine check(s) failed');
  process.exit(1);
}
console.log('All engine checks passed');
