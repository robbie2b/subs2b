import { Request, Response } from 'express';
import path from 'path';
import { getPack } from '../storage/subsroStore';
import { configStorage } from '../storage/configStore';
import { extractEntry } from '../utils/archiveEntries';
import { entryFromToken, entriesFor, fetchPack, SUBSRO_PROVIDER_ID } from '../providers/subsroDirect';
import { toCleanUtf8, validateAndFormatSubtitle, sendSubtitleResponse, pickArchiveEntry } from './subtitleProxy';
import { Logger } from '../utils/logger';

/**
 * A subtitle of a Subs.ro pack, served by this server.
 *   /proxy/download/subsro/<pack>/<file>.srt      a file of a pack kept already (no request to Subs.ro)
 *   /proxy/download/subsro/<pack>/pick.srt?s&e&vf&v&c   a pack listed without being opened: it is downloaded NOW (one
 *                                         request, shared by everyone asking at once, kept for the next time) and the file
 *                                         for the episode, closest to the playing file `vf`, is served. `c` is the
 *                                         configuration (its Subs.ro key is read here: no key is ever in a link).
 */
export async function handleSubsroDownload(req: Request, res: Response): Promise<void> {
  const packId = String(req.params.packId || '');
  const token = String(req.params.entry || '').replace(/\.srt$/i, '');
  if (!/^\d+$/.test(packId) || !token) {
    res.status(400).send('Invalid Subs.ro subtitle link');
    return;
  }
  const num = (v: unknown): number | null => { const n = parseInt(String(v ?? ''), 10); return isNaN(n) ? null : n; };
  try {
    let entry: string | undefined;
    let pack = null as Awaited<ReturnType<typeof getPack>>;

    if (token === 'pick') {
      const season = num(req.query.s);
      const episode = num(req.query.e);
      const version = typeof req.query.v === 'string' ? req.query.v : '';
      const uuid = typeof req.query.c === 'string' ? req.query.c : '';
      const config = uuid ? await configStorage.getConfigByUuidAsync(uuid) : null;
      const apiKey = config?.providers?.[SUBSRO_PROVIDER_ID]?.apiKey?.trim();
      pack = await getPack(packId);
      if (!pack || (version && pack.version !== version)) {
        if (!apiKey) { res.status(404).send('This Subs.ro pack is not kept on this server and its key is not known here'); return; }
        pack = await fetchPack(packId, version, apiKey);
      }
      const candidates = entriesFor(pack.entries, { season, episode });
      if (candidates.length === 0) { res.status(404).send('The Subs.ro pack has no subtitle for this episode'); return; }
      entry = candidates.length === 1
        ? candidates[0]
        : pickArchiveEntry(candidates.map(entryName => ({ entryName })), { season, episode, videoFilename: typeof req.query.vf === 'string' ? req.query.vf : null })?.entryName || candidates[0];
    } else {
      entry = entryFromToken(token);
      pack = await getPack(packId);
      // (only a file the pack was listed with can be asked for)
      if (!pack || !pack.entries.includes(entry)) {
        res.status(404).send('This Subs.ro pack is not kept on this server any more: open the film again');
        return;
      }
    }

    const bytes = await extractEntry(pack.archive, entry);
    if (!bytes) {
      res.status(404).send('The subtitle is not in the pack');
      return;
    }
    // (old Romanian files without a byte order mark are in the Central European code page)
    const validation = validateAndFormatSubtitle(toCleanUtf8(bytes, 'win1250'), 'srt');
    if (!validation.valid) {
      res.status(502).send(`Failed to process the subtitle: ${validation.reason}`);
      return;
    }
    sendSubtitleResponse(res, validation.content, validation.format, path.basename(entry));
  } catch (err) {
    Logger.error('Subs.ro download failed', err);
    res.status(502).send(`Could not get the subtitle: ${err instanceof Error ? err.message : 'error'}`);
  }
}
