/**
 * Subtitle timelines: reading cue times (start/end only). The alignment itself is in subsync.ts.
 */

export interface Cue {
  start: number;
  end: number;
}

const TIMING = /(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/g;

/** Cue start/end times (seconds) of an SRT or WebVTT text */
export function parseCues(text: string): Cue[] {
  const cues: Cue[] = [];
  const ms = (v: string): number => parseInt(v.padEnd(3, '0'), 10) / 1000;
  const seconds = (h: string | undefined, m: string, s: string, f: string): number =>
    (h ? parseInt(h, 10) * 3600 : 0) + parseInt(m, 10) * 60 + parseInt(s, 10) + ms(f);

  TIMING.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TIMING.exec(text)) !== null) {
    const start = seconds(match[1], match[2], match[3], match[4]);
    const end = seconds(match[5], match[6], match[7], match[8]);
    if (end > start) cues.push({ start, end });
  }
  return cues;
}
