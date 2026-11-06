import path from 'path';
import AdmZip from 'adm-zip';

/**
 * Subtitle files inside a ZIP or RAR archive: their names, and the bytes of one of them. Used for the Subs.ro packs
 * (a pack holds a whole season, one folder per release).
 */

const MAX_ENTRY_BYTES = 5 * 1024 * 1024;

export const isRar = (buf: Buffer): boolean => buf.length > 4 && buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21;

const usable = (name: string): boolean =>
  /\.srt$/i.test(name) && !name.includes('__MACOSX') && !path.basename(name).startsWith('.');

/** The .srt files of the archive (paths as written inside it) */
export async function listSrtEntries(buf: Buffer): Promise<string[]> {
  if (isRar(buf)) {
    const { createExtractorFromData } = await import('node-unrar-js');
    const extractor = await createExtractorFromData({ data: Uint8Array.from(buf).buffer });
    return [...extractor.getFileList().fileHeaders]
      .filter(h => !h.flags.directory && !h.flags.encrypted && h.unpSize <= MAX_ENTRY_BYTES && usable(h.name))
      .map(h => h.name);
  }
  return new AdmZip(buf).getEntries()
    .filter(e => !e.isDirectory && e.header.size <= MAX_ENTRY_BYTES && usable(e.entryName))
    .map(e => e.entryName);
}

/** The bytes of one file of the archive, or null when it is not there */
export async function extractEntry(buf: Buffer, name: string): Promise<Buffer | null> {
  if (isRar(buf)) {
    const { createExtractorFromData } = await import('node-unrar-js');
    const extractor = await createExtractorFromData({ data: Uint8Array.from(buf).buffer });
    const file = [...extractor.extract({ files: [name] }).files][0];
    return file && file.extraction && file.extraction.length <= MAX_ENTRY_BYTES ? Buffer.from(file.extraction) : null;
  }
  const entry = new AdmZip(buf).getEntry(name);
  return entry && entry.header.size <= MAX_ENTRY_BYTES ? entry.getData() : null;
}
