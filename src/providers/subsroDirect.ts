import path from 'path';
import axios from 'axios';
import { BaseSubtitleProvider } from './base';
import { SubtitleQuery, ProviderContext, RawSubtitleItem } from '../types/provider';
import { shortHash } from '../utils/ids';
import { parseRelease, rankSubtitles } from '../utils/scorer';
import { listSrtEntries } from '../utils/archiveEntries';
import { getSearch, setSearch, getPack, setPack } from '../storage/subsroStore';
import { Logger } from '../utils/logger';
import { USER_AGENT } from '../config/version';

/**
 * Subs.ro through its own API (https://api.subs.ro/v1.0, key from subs.ro/utilizator/api, docs at subs.ro/api; a free key, 300 requests a day).
 *
 * A search by IMDb id returns one entry per archive ("pack": a film, or a season, or several seasons), not one per
 * subtitle; the subtitles are the .srt files inside, one folder per release. The ideas follow the community Subs.ro
 * Stremio addon (github.com/allecsc/stremio-subs-ro, GPL v3), which lists the files of every archive of the title;
 * here only the packs of the season being played are opened, and everything fetched (the search, the packs and the
 * names of the files in them) is kept in PostgreSQL, so the daily limit is spent once per pack and not again.
 */

export const SUBSRO_API = 'https://api.subs.ro/v1.0';
export const SUBSRO_PROVIDER_ID = 'subsrodirect';
const MAX_PACKS = 3;
/**
 * Packs are opened one after the other, the best first, until a subtitle was found (each opened pack is a request): the
 * next one only when the best has nothing for the episode. The other sources give the alternatives, and the player gets
 * its few subtitles from all of them together.
 */
const WANTED_SUBTITLES = 1;
const MAX_PACK_BYTES = 60 * 1024 * 1024;
/** Below this many requests left today the source is not used any more (the quota check itself is free) */
const QUOTA_RESERVE = 15;

export interface SubsroItem {
  id: number | string;
  title?: string;
  description?: string;
  type?: string;
  language?: string;
  translator?: string;
  updatedAt?: string;
  createdAt?: string;
}

/** The site's language codes, as the rest of the addon names languages */
const LANGUAGES: Record<string, string> = { ro: 'ron', en: 'eng', ita: 'ita', fra: 'fra', ger: 'deu', ung: 'hun', gre: 'ell', por: 'por', spa: 'spa' };

/** The seasons a pack is for: "Sezonul 4", "Sezoanele 1-24", "Season 2" (null when it says nothing) */
export function seasonsOf(item: Pick<SubsroItem, 'title' | 'description'>): { from: number; to: number } | null {
  for (const text of [item.title || '', item.description || '']) {
    const range = /\bsezoanele?\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\b/i.exec(text);
    if (range) return { from: parseInt(range[1], 10), to: parseInt(range[2], 10) };
    const one = /\b(?:sezonul|season|sez\.?)\s*(\d{1,2})\b/i.exec(text);
    if (one) { const n = parseInt(one[1], 10); return { from: n, to: n }; }
  }
  return null;
}

/**
 * A pack whose description plainly says it holds other episodes ("Ep.1-4", "Episoadele 5-9", "Ep. 3") cannot have the
 * one being played. Anything less clear stays a candidate (a wrong guess would hide a good subtitle).
 */
export function excludesEpisode(description: string | undefined, episode: number): boolean {
  const text = (description || '').trim().toLowerCase().replace(/[.!\s]+$/g, '');
  if (!text || /complet|toate|sezon/.test(text)) return false;
  const range = /^(?:ep(?:isoadele|isodul)?\.?\s*)(\d{1,3})\s*[-–]\s*(\d{1,3})$/.exec(text);
  if (range) return episode < parseInt(range[1], 10) || episode > parseInt(range[2], 10);
  const single = /^(?:ep(?:isodul)?\.?\s*)(\d{1,3})$/.exec(text);
  return single ? episode !== parseInt(single[1], 10) : false;
}

/**
 * The packs worth opening for what is being played, the best match for the playing file first. A film's pack says in
 * its description which releases it holds, so the order follows the same scoring as the subtitles themselves; where that
 * says nothing the newest goes first. At most MAX_PACKS.
 */
export function choosePacks(items: SubsroItem[], query: Pick<SubtitleQuery, 'season' | 'episode'>, languages: string[], filename?: string | null): SubsroItem[] {
  const isSeries = query.season != null && query.episode != null;
  const wanted = items.filter(i => {
    const lang = LANGUAGES[(i.language || '').toLowerCase()];
    return lang && languages.includes(lang);
  });
  const chosen = wanted.filter(i => {
    if (!isSeries) return true;
    const seasons = seasonsOf(i);
    if (!seasons || query.season! < seasons.from || query.season! > seasons.to) return false;
    return !excludesEpisode(i.description, query.episode!);
  });
  const when = (i: SubsroItem) => Date.parse(i.updatedAt || i.createdAt || '') || 0;
  const byDate = chosen.slice().sort((a, b) => when(b) - when(a));
  if (!filename || byDate.length < 2) return byDate.slice(0, MAX_PACKS);
  // closest to the playing file first (the description is a list of release names; a title alone says little)
  try {
    const asItems: RawSubtitleItem[] = byDate.map((i, n) => ({
      id: String(n), provider: SUBSRO_PROVIDER_ID, providerName: 'Subs.ro', url: '', lang: 'x',
      release: ((i.description || '').replace(/\s+/g, ' ').trim() || i.title || '').slice(0, 400)
    }));
    const ranked = rankSubtitles(asItems, { filename, season: query.season ?? null, episode: query.episode ?? null });
    if (!ranked.fallback && ranked.items.length === byDate.length) {
      return ranked.items.map(r => byDate[parseInt(r.id, 10)]).slice(0, MAX_PACKS);
    }
  } catch {
    // the order by date stands
  }
  return byDate.slice(0, MAX_PACKS);
}

/** Episode written in a file name without a full S01E02 marker ("Show - 04", "Show E04") */
function looseEpisode(name: string): number | null {
  const base = path.basename(name).replace(/\.[a-z0-9]{2,4}$/i, '');
  const withE = base.match(/(?:^|[\s._\-[(])(?:e|ep|episode|episodul)\s?0*(\d{1,3})(?:[\s._\-\])]|$)/i);
  if (withE) return parseInt(withE[1], 10);
  const trailing = base.match(/[\s._-]0*(\d{1,3})$/);
  return trailing ? parseInt(trailing[1], 10) : null;
}

/** The files of a pack that are for the episode being played (every file for a film) */
export function entriesFor(entries: string[], query: Pick<SubtitleQuery, 'season' | 'episode'>): string[] {
  if (query.season == null || query.episode == null) return entries;
  return entries.filter(name => {
    const parsed = parseRelease(path.basename(name));
    if (parsed.episode !== null) return parsed.episode === query.episode && (parsed.season === null || parsed.season === query.season);
    return looseEpisode(name) === query.episode;
  });
}

export const entryToken = (entry: string): string => Buffer.from(entry).toString('base64url');
export const entryFromToken = (token: string): string => Buffer.from(token, 'base64url').toString('utf8');

// --- the daily limit: /quota does not count as a request ---
const quotaSeen = new Map<string, { at: number; remaining: number }>();
async function remainingToday(apiKey: string, signal: AbortSignal): Promise<number | null> {
  const seen = quotaSeen.get(apiKey);
  if (seen && Date.now() - seen.at < 2 * 60 * 1000) return seen.remaining;
  try {
    const res = await axios.get(`${SUBSRO_API}/quota`, { headers: { 'X-Subs-Api-Key': apiKey, Accept: 'application/json', 'User-Agent': USER_AGENT }, timeout: 4000, signal });
    const quota = res.data?.quota || {};
    const remaining = typeof quota.remaining === 'number' ? quota.remaining : typeof quota.remaining_quota === 'number' ? quota.remaining_quota : null;
    if (remaining !== null) quotaSeen.set(apiKey, { at: Date.now(), remaining });
    return remaining;
  } catch {
    return null;
  }
}

export class SubsroDirectProvider extends BaseSubtitleProvider {
  readonly id = SUBSRO_PROVIDER_ID;
  readonly name = 'Subs.ro (direct)';
  readonly description = 'Subtitles from Subs.ro through its own API (free key, 300 requests a day; everything fetched is kept).';
  readonly requiresApiKey = true;
  readonly defaultEnabled = false;

  private headers(apiKey: string) {
    return { 'X-Subs-Api-Key': apiKey, Accept: 'application/json', 'User-Agent': USER_AGENT };
  }

  /** The pack (from memory, the database, or the API when new or changed): one request only in the last case */
  private async packOf(item: SubsroItem, apiKey: string, signal: AbortSignal) {
    const id = String(item.id);
    const version = String(item.updatedAt || item.createdAt || '');
    const stored = await getPack(id);
    if (stored && stored.version === version) return stored;
    const res = await axios.get<ArrayBuffer>(`${SUBSRO_API}/subtitle/${encodeURIComponent(id)}/download`, {
      headers: this.headers(apiKey), responseType: 'arraybuffer', timeout: 25000, maxContentLength: MAX_PACK_BYTES, signal
    });
    const archive = Buffer.from(res.data);
    const entries = await listSrtEntries(archive);
    const pack = { version, entries, archive };
    setPack(id, pack);
    return pack;
  }

  protected async executeSearch(query: SubtitleQuery, context: ProviderContext, signal: AbortSignal): Promise<RawSubtitleItem[]> {
    const apiKey = context.providerConfig?.apiKey?.trim();
    // (the timing references are searched in every language by the services; this one is never used for them: it
    // would spend the daily limit on files nobody reads)
    if (!apiKey || !query.imdbId || query.allLanguages) return [];
    const imdb = query.imdbId.startsWith('tt') ? query.imdbId : `tt${query.imdbId}`;

    const left = await remainingToday(apiKey, signal);
    if (left !== null && left < QUOTA_RESERVE) throw new Error(`Subs.ro daily limit almost reached (${left} requests left today)`);

    let items = (await getSearch(imdb)) as SubsroItem[] | null;
    if (!items) {
      const res = await this.httpGet<{ items?: SubsroItem[] }>(`${SUBSRO_API}/search/imdbid/${imdb}`, { headers: this.headers(apiKey), timeout: 8000 }, signal);
      items = Array.isArray(res.data?.items) ? res.data.items : [];
      setSearch(imdb, items);
    }

    const languages = context.config.languages && context.config.languages.length > 0 ? context.config.languages : ['ron', 'eng'];
    const packs = choosePacks(items, query, languages, query.extra?.filename);
    const wanted = WANTED_SUBTITLES;
    const out: RawSubtitleItem[] = [];
    // the best pack first; the next ones only while there are too few subtitles (a pack kept already costs nothing)
    for (const item of packs) {
      if (out.length >= wanted || signal.aborted) break;
      try {
        const pack = await this.packOf(item, apiKey, signal);
        const lang = LANGUAGES[(item.language || '').toLowerCase()];
        for (const entry of entriesFor(pack.entries, query)) {
          const release = path.basename(entry).replace(/\.srt$/i, '');
          out.push({
            id: `${SUBSRO_PROVIDER_ID}-${item.id}-${shortHash(entry)}`,
            provider: this.id,
            providerName: 'Subs.ro',
            url: `/proxy/download/subsro/${encodeURIComponent(String(item.id))}/${entryToken(entry)}.srt`,
            lang,
            release,
            format: 'srt',
            hearingImpaired: /\[cc\]|\.cc\.|\[hi\]|\(hi\)|hearing/i.test(release)
          });
        }
      } catch (err) {
        if (signal.aborted) break;
        Logger.warn(`Subs.ro pack ${item.id} could not be read`, { reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  }
}
