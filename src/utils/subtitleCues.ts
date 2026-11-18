import { isWebVtt, vttToSrt } from './subtitleFormat';

/** One subtitle cue with its text (times in seconds) */
export interface TextCue {
  start: number;
  end: number;
  text: string;
}

const TIMING = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/;

const sec = (h: string, m: string, s: string, f: string): number =>
  (parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10)) + parseInt(f.padEnd(3, '0'), 10) / 1000;

/**
 * The cues of a text, found by their time lines (not by blank lines): a cue whose blank line to the next one is missing,
 * a blank line inside a cue's text, a missing or odd index number, a BOM: none of them loses a cue or its text.
 * The number line right before a time line is that cue's index, not the end of the previous cue's text.
 */
function parseCues(text: string): Array<{ start: number; end: number; body: string }> {
  const source = (isWebVtt(text) ? vttToSrt(text) : text).replace(/^\uFEFF/, '');
  const lines = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const heads: Array<{ line: number; start: number; end: number }> = [];
  lines.forEach((l, n) => {
    if (!l.includes('-->')) return;
    const m = TIMING.exec(l);
    if (!m) return;
    const start = sec(m[1], m[2], m[3], m[4]);
    const end = sec(m[5], m[6], m[7], m[8]);
    if (end > start) heads.push({ line: n, start, end });
  });
  // every time line, even one that is not a valid cue (end before start), closes the text of the cue before it
  const allTimeLines = lines.map((l, n) => (l.includes('-->') && TIMING.test(l) ? n : -1)).filter(n => n >= 0);
  const out: Array<{ start: number; end: number; body: string }> = [];
  let k = 0;
  for (const h of heads) {
    while (k < allTimeLines.length && allTimeLines[k] <= h.line) k++;
    const next = k < allTimeLines.length ? allTimeLines[k] : undefined;
    let stop = next === undefined ? lines.length : next;
    if (next !== undefined && stop - 1 > h.line && /^\s*\d+\s*$/.test(lines[stop - 1])) stop--;
    const body = lines.slice(h.line + 1, stop).filter(l => l.trim() !== '').join('\n').trim();
    out.push({ start: h.start, end: h.end, body });
  }
  return out;
}

/** Cues of an SRT/WebVTT text in file order, with their text */
export function readCues(text: string): TextCue[] {
  return parseCues(text).map(c => ({ start: c.start, end: c.end, text: c.body }));
}

const fromSec = (total: number): string => {
  const t = Math.max(0, Math.round(total * 1000));
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(t / 3600000))}:${p(Math.floor((t % 3600000) / 60000))}:${p(Math.floor((t % 60000) / 1000))},${p(t % 1000, 3)}`;
};

/**
 * Writes the subtitle again with every cue moved by `map(index, start, end)` (index = position in readCues' list).
 * Cues that would end before the start of the video are dropped; the text is untouched. Output is SRT.
 */
export function retimeSubtitle(text: string, map: (index: number, start: number, end: number) => [number, number]): string {
  const out: string[] = [];
  let index = 0;
  for (const c of parseCues(text)) {
    const [ns, ne] = map(index++, c.start, c.end);
    if (ne <= 0) continue;
    out.push(`${out.length + 1}\n${fromSec(ns)} --> ${fromSec(Math.max(ne, ns + 0.001))}\n${c.body}`);
  }
  return out.join('\n\n') + '\n';
}
