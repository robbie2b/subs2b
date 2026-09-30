/**
 * Subtitle format helpers.
 *
 * vttToSrt turns a WebVTT file into plain SRT. Besides the timestamp format it drops everything that makes a player
 * treat the subtitle as "styled": cue settings (align/position/line/size), STYLE/REGION/NOTE blocks, ASS positioning
 * tags such as {\an8} and VTT-only markup, so the player applies the viewer's own size and position settings.
 */

/** Formats a WebVTT/SRT timestamp ("1:02.5", "00:01:02.500", "00:01:02,500") as SRT ("00:01:02,500") */
function toSrtTime(raw: string): string {
  const [clock, fraction = '0'] = raw.replace(',', '.').split('.');
  const parts = clock.split(':').map(p => p.padStart(2, '0'));
  while (parts.length < 3) parts.unshift('00');
  return `${parts.join(':')},${fraction.padEnd(3, '0').slice(0, 3)}`;
}

const NAMED_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
  '&lrm;': '',
  '&rlm;': ''
};

function decodeEntities(text: string): string {
  return text
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|lrm|rlm);/g, m => NAMED_ENTITIES[m])
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/** Keeps <i>, <b>, <u>; removes every other tag (<c.yellow>, <v Name>, <lang en>, <00:01.000>...) */
function cleanCueText(text: string): string {
  const withoutMarkup = text
    .replace(/\{\\[^}]*\}/g, '') // ASS positioning/styling such as {\an8}
    .replace(/<(?!\/?(?:i|b|u)>)[^>]*>/gi, '');
  return decodeEntities(withoutMarkup)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .join('\n');
}

const TIMING = /^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})(.*)$/;

export function isWebVtt(text: string): boolean {
  return /^﻿?WEBVTT/.test(text);
}

export function vttToSrt(input: string): string {
  const text = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks = text.split(/\n{2,}/);
  const cues: string[] = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    const first = lines[0].trim();
    if (first.startsWith('WEBVTT') || /^(NOTE|STYLE|REGION)(\s|$)/.test(first)) continue;

    const timingIndex = lines.findIndex(line => line.includes('-->'));
    if (timingIndex < 0) continue;
    const timing = TIMING.exec(lines[timingIndex]);
    if (!timing) continue;

    // Anything after the timestamps is a cue setting (align:start position:10% line:90%): dropped on purpose
    const body = cleanCueText(lines.slice(timingIndex + 1).join('\n'));
    if (!body) continue;

    cues.push(`${cues.length + 1}\n${toSrtTime(timing[1])} --> ${toSrtTime(timing[2])}\n${body}`);
  }

  return cues.join('\n\n') + (cues.length > 0 ? '\n' : '');
}

/** MicroDVD (".sub" with frame numbers: "{508}{583}text|second line") */
export function isMicroDvd(text: string): boolean {
  const first = text.replace(/^﻿/, '').trimStart().split(/\r?\n/, 1)[0] || '';
  return /^\{\d+\}\{\d+\}/.test(first);
}

/** Converts MicroDVD to SRT. Without a frame rate in the file, 23.976 fps is assumed (the usual one for rips). */
export function microDvdToSrt(text: string, fpsDefault = 23.976): string {
  const lines = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n');
  let fps = fpsDefault;

  // some files carry the frame rate in a first cue like "{1}{1}23.976"
  const header = lines[0]?.match(/^\{1\}\{1\}(\d+(?:\.\d+)?)\s*$/);
  if (header) {
    const declared = parseFloat(header[1]);
    if (declared >= 10 && declared <= 60) fps = declared;
  }

  const stamp = (frame: number): string => {
    let ms = Math.round((frame / fps) * 1000);
    const h = Math.floor(ms / 3600000); ms -= h * 3600000;
    const m = Math.floor(ms / 60000); ms -= m * 60000;
    const s = Math.floor(ms / 1000); ms -= s * 1000;
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
  };

  const cues: Array<{ start: number; end: number; text: string }> = [];
  for (const line of lines) {
    const m = line.match(/^\{(\d+)\}\{(\d+)\}(.*)$/);
    if (!m) continue;
    if (m[1] === '1' && m[2] === '1' && /^\d+(\.\d+)?$/.test(m[3].trim())) continue;
    const body = m[3].replace(/\{[a-zA-Z]:[^}]*\}/g, '').replace(/\|/g, '\n').trim();
    if (body) cues.push({ start: parseInt(m[1], 10), end: parseInt(m[2], 10), text: body });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n');
}
