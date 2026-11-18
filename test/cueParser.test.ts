import { readCues, retimeSubtitle } from '../src/utils/subtitleCues';

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) console.log(`  ok  ${name}`); else { failed++; console.log(`  FAIL  ${name}`, detail ?? ''); }
};

// a normal file
const normal = '1\n00:00:01,000 --> 00:00:03,000\nHello\n\n2\n00:00:04,000 --> 00:00:06,000\nWorld\nsecond line\n\n';
check('a normal file is read', readCues(normal).length === 2 && readCues(normal)[1].text === 'World\nsecond line');

// the blank line between two cues is missing: the second cue is not lost
const glued = '1\n00:00:01,000 --> 00:00:03,000\nHello\n2\n00:00:04,000 --> 00:00:06,000\nWorld\n';
const g = readCues(glued);
check('a missing blank line between cues loses nothing (and the index is not part of the text)', g.length === 2 && g[0].text === 'Hello' && g[1].text === 'World', g);

// a blank line inside the text of a cue: the rest of the text is kept
const split = '1\n00:00:01,000 --> 00:00:03,000\nFirst part\n\nsecond part\n\n2\n00:00:04,000 --> 00:00:06,000\nNext\n';
const s = readCues(split);
check('a blank line inside a cue keeps all of its text', s.length === 2 && s[0].text === 'First part\nsecond part' && s[1].text === 'Next', s);

// BOM and no index numbers at all
const bare = '﻿00:00:01,000 --> 00:00:03,000\nOne\n\n00:00:04,000 --> 00:00:06,000\nTwo\n';
check('a BOM and missing indexes are fine', readCues(bare).map(c => c.text).join('|') === 'One|Two', readCues(bare));

// a cue whose text is a year: kept (it is followed by a blank line and an index)
const year = '1\n00:00:01,000 --> 00:00:03,000\n1999\n\n2\n00:00:04,000 --> 00:00:06,000\nNext\n';
check('a text that is just a number is kept', readCues(year)[0].text === '1999', readCues(year));

// a bad time line (end before start) does not swallow the next cue's text into the previous one
const bad = '1\n00:00:01,000 --> 00:00:03,000\nGood\n2\n00:00:09,000 --> 00:00:05,000\nBroken\n3\n00:00:10,000 --> 00:00:12,000\nAfter\n';
check('a broken cue is skipped and its text does not leak into the cue before it', readCues(bad).map(c => c.text).join('|') === 'Good|After', readCues(bad));

// retiming keeps every cue and its full text
const r = retimeSubtitle(glued, (_i, a, b) => [a + 1, b + 1]);
check('retiming a glued file writes both cues, separated properly', readCues(r).length === 2 && r.includes('00:00:02,000 --> 00:00:04,000'), r);

if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log('All cue parser checks passed');
