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

function toSrtBlocks(text: string): string[] {
  const source = isWebVtt(text) ? vttToSrt(text) : text;
  return source.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/\n{2,}/);
}

/** Cues of an SRT/WebVTT text in file order, with their text */
export function readCues(text: string): TextCue[] {
  const cues: TextCue[] = [];
  for (const block of toSrtBlocks(text)) {
    const lines = block.split('\n');
    const i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    const m = TIMING.exec(lines[i]);
    if (!m) continue;
    const start = sec(m[1], m[2], m[3], m[4]);
    const end = sec(m[5], m[6], m[7], m[8]);
    if (!(end > start)) continue;
    cues.push({ start, end, text: lines.slice(i + 1).join('\n').trim() });
  }
  return cues;
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
  for (const block of toSrtBlocks(text)) {
    const lines = block.split('\n');
    const i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    const m = TIMING.exec(lines[i]);
    if (!m) continue;
    const start = sec(m[1], m[2], m[3], m[4]);
    const end = sec(m[5], m[6], m[7], m[8]);
    if (!(end > start)) continue;
    const [ns, ne] = map(index++, start, end);
    if (ne <= 0) continue;
    const body = lines.slice(i + 1).join('\n').trim();
    out.push(`${out.length + 1}\n${fromSec(ns)} --> ${fromSec(Math.max(ne, ns + 0.001))}\n${body}`);
  }
  return out.join('\n\n') + '\n';
}
