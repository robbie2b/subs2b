import { RawSubtitleItem } from '../types/provider';
import { parseRelease, variantsOf, Source, ParsedRelease } from './scorer';

/**
 * The short, readable name a subtitle gets in the list. Nuvio shows the subtitle's id under its language (and no
 * client shows the title), so the id carries this label instead of a technical one:
 *   ★ Subs.ro · 2160p BluRay · MainFrame
 * the source, what kind of release it is (resolution, service, source), its release group; a star for the
 * subtitles put on the top level (an exact hash match, or a name that is exactly the playing file's release).
 * It depends only on the subtitle and the playing file, never on the position in the list or the score, so it is the
 * same at every opening of the film.
 */

/** Longest label (the line of a TV player takes about 45 characters) */
export const MAX_LABEL_LENGTH = 44;

const SOURCE_BY_PROVIDER: Record<string, string> = {
  opensubtitles: 'OpenSubtitles',
  subdl: 'SubDL',
  subsource: 'Subsource',
  regielive: 'RegieLive',
  subsrodirect: 'Subs.ro',
  titrari: 'Titrari',
  subtitrarinoi: 'Subtitrari-noi',
  yify: 'YIFY',
  addic7ed: 'Addic7ed',
  wyzie: 'Wyzie',
  'org.stremio.subsro': 'Subs.ro',
  'org.stremio.opensubtitlesv3': 'OpenSubtitles v3',
  'community.opensubtitlesv3.pro': 'OpenSubtitles PRO'
};

const SOURCE_LABEL: Record<Source, string> = {
  remux: 'REMUX', bluray: 'BluRay', webdl: 'WEB-DL', webrip: 'WEBRip', hdtv: 'HDTV', dvd: 'DVD', hdrip: 'HDRip', cam: 'CAM'
};

const SERVICE_LABEL: Record<string, string> = {
  nf: 'NF', amzn: 'AMZN', dsnp: 'DSNP', hmax: 'HMAX', atvp: 'ATVP', hulu: 'Hulu', pcok: 'PCOK', pmtp: 'PMTP', voyo: 'VOYO'
};

/** The name of the place a subtitle comes from, short ("Subs.ro", "Subtitrari-noi") */
export function sourceName(item: Pick<RawSubtitleItem, 'provider' | 'providerName'>): string {
  const known = SOURCE_BY_PROVIDER[(item.provider || '').toLowerCase()];
  if (known) return known;
  // an imported addon: its own name without a trailing "Subtitles" and without a bracketed note
  const name = (item.providerName || item.provider || '').replace(/\s*\([^)]*\)\s*/g, ' ').trim().replace(/\s+subtitles?$/i, '').trim();
  return name || item.provider || 'subs2b';
}

/**
 * Of the releases a name stands for ("A; B; C", or a title with a release in brackets) the one closest to the playing
 * file: it is the one that explains the place of the subtitle in the list (a name may list dozens of releases).
 */
function closestVariant(release: string, video: ParsedRelease | null): { text: string; parsed: ParsedRelease } {
  const variants = variantsOf(release).filter(Boolean);
  const list = variants.length ? variants : [release];
  let best = { text: list[0], parsed: parseRelease(list[0]) };
  if (!video) return best;
  let bestPoints = -1;
  for (const text of list) {
    const p = parseRelease(text);
    const points =
      (p.group && video.group && p.group === video.group ? 4 : 0) +
      (p.source && p.source === video.source ? 2 : 0) +
      (p.resolution && p.resolution === video.resolution ? 2 : p.resolution && video.resolution && (p.resolution >= 2160) === (video.resolution >= 2160) ? 1 : 0) +
      (p.service && p.service === video.service ? 1 : 0);
    if (points > bestPoints) { bestPoints = points; best = { text, parsed: p }; }
  }
  return best;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The release group with its own capitals ("NTb"), found again in the text the lowercase group was read from */
function groupAsWritten(text: string, group: string): string {
  const m = new RegExp(`-\\s*(${escapeRe(group)})(?![A-Za-z0-9])`, 'ig');
  let last: string | null = null;
  for (let r = m.exec(text); r; r = m.exec(text)) last = r[1];
  return last || group.toUpperCase();
}

/** BluRay, or the smaller rip of it (BRRip, BDRip: a 700 MB encode, not the disc) */
function sourceLabel(parsed: ParsedRelease, text: string): string {
  if (!parsed.source) return '';
  if (parsed.source === 'bluray') {
    const rip = /\b(br|bd) ?rip\b/i.exec(text.replace(/[._]+/g, ' '));
    if (rip) return `${rip[1].toUpperCase()}Rip`;
  }
  return SOURCE_LABEL[parsed.source];
}

const shorten = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`);

export interface LabelOptions {
  /** the playing file's name, to pick the variant of a name that lists several releases */
  filename?: string | null;
  /** a hash match, or a name exactly the file's release: gets the star */
  topLevel?: boolean;
}

export function subtitleLabel(item: RawSubtitleItem, options: LabelOptions = {}): string {
  const video = options.filename && options.filename.trim() ? parseRelease(options.filename.trim()) : null;
  const release = (item.release || '').trim();
  const { text, parsed } = closestVariant(release, video);

  const kind = [
    parsed.resolution ? (parsed.resolution <= 480 ? 'SD' : `${parsed.resolution}p`) : '',
    parsed.service ? SERVICE_LABEL[parsed.service] || parsed.service.toUpperCase() : '',
    sourceLabel(parsed, text),
    // an old XviD encode is worth showing: it is not the quality the rest of the name suggests
    parsed.codec === 'xvid' ? 'XviD' : ''
  ].filter(Boolean).join(' ');
  // (a "group" that is only the codec's name, as in "...MP3-XVID", is not a group)
  const group = parsed.group && parsed.group !== 'xvid' ? groupAsWritten(text, parsed.group) : '';

  const star = options.topLevel ? '★ ' : '';
  const source = sourceName(item);
  let parts = [source, kind, group].filter(Boolean);
  // nothing readable in the name (no resolution, source or group): the start of the name itself
  // (unless that is only the source's own placeholder name, "OpenSubtitles v3 Subtitle")
  const bare = release.replace(/\.(srt|vtt)$/i, '');
  if (!kind && !group && bare && !bare.toLowerCase().startsWith(source.toLowerCase())) parts = [source, bare];

  const full = `${star}${parts.join(' · ')}`;
  if (full.length <= MAX_LABEL_LENGTH) return full;
  // too long: the group (or the name) gives way first, then the whole line is cut
  const shortParts = parts.slice(0, -1);
  const last = parts[parts.length - 1];
  const room = MAX_LABEL_LENGTH - `${star}${shortParts.join(' · ')} · `.length;
  if (shortParts.length && room >= 6) return `${star}${shortParts.join(' · ')} · ${shorten(last, room)}`;
  return shorten(full, MAX_LABEL_LENGTH);
}
