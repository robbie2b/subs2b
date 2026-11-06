import { Request, Response } from 'express';
import { getPack } from '../storage/subsroStore';
import { extractEntry } from '../utils/archiveEntries';
import { entryFromToken } from '../providers/subsroDirect';
import { toCleanUtf8, validateAndFormatSubtitle, sendSubtitleResponse } from './subtitleProxy';
import { Logger } from '../utils/logger';
import path from 'path';

/**
 * One subtitle of a Subs.ro pack, served from the pack kept by the search (memory or database): no request to Subs.ro.
 * A pack that is not kept (aged out) is a 404: the search puts it back, and the aligned links go on to the next
 * subtitle meanwhile.
 */
export async function handleSubsroDownload(req: Request, res: Response): Promise<void> {
  const packId = String(req.params.packId || '');
  const token = String(req.params.entry || '').replace(/\.srt$/i, '');
  if (!/^\d+$/.test(packId) || !token) {
    res.status(400).send('Invalid Subs.ro subtitle link');
    return;
  }
  try {
    const entry = entryFromToken(token);
    const pack = await getPack(packId);
    // (only a file the pack was listed with can be asked for)
    if (!pack || !pack.entries.includes(entry)) {
      res.status(404).send('This Subs.ro pack is not kept on this server any more: open the film again');
      return;
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
    res.status(500).send('Could not read the subtitle');
  }
}
