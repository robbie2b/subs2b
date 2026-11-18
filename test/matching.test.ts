// Is a subtitle for the right film/episode? Cases from real plays (Ocean's Eleven, Schindler's List, Naruto, Friends,
// Wyzie multi-part names...) that the first matcher got wrong.
import { parseRelease, rankSubtitles } from '../src/utils/scorer';
import { deduplicateSubtitles } from '../src/utils/deduplicator';
import { RawSubtitleItem } from '../src/types/provider';
import { parseExtraSegment } from '../src/utils/extraArgs';
import { subsourceLanguageNames } from '../src/providers/subsource';

let failed = 0;
function check(label: string, ok: boolean, info?: unknown): void {
  if (ok) console.log('  ok  ' + label);
  else { failed++; console.error('FAIL ' + label, info !== undefined ? JSON.stringify(info) : ''); }
}
const item = (release: string, provider = 'subdl', extra: Partial<RawSubtitleItem> = {}): RawSubtitleItem =>
  ({ id: provider + ':' + release, provider, providerName: provider, url: '/x/' + release, lang: 'ron', release, ...extra });
const kept = (r: ReturnType<typeof rankSubtitles>) => r.items.map(i => i.release);

// an apostrophe joins, it does not split
{
  const file = "Ocean's Eleven (2001) 1080p BluRay REMUX AVC DTS-HD MA 5.1-EPSiLON.mkv";
  const r = rankSubtitles([
    item('Oceans.Eleven.2001.1080p.BluRay.REMUX.AVC-EPSiLON', 'org.stremio.subsro'),
    item('Oceans.Eleven.2001.720p.BluRay.x264-GRP', 'org.stremio.subsro'),
    item("Ocean's Eleven (2001) BRRip", 'regielive'),
    item('Ocean.s.Eleven.2001.1080p.BluRay.x264-OTHER', 'subdl')
  ], { filename: file });
  check("Oceans.Eleven (no apostrophe) is the film of the file Ocean's Eleven", kept(r).includes('Oceans.Eleven.2001.1080p.BluRay.REMUX.AVC-EPSiLON'), kept(r));
  check('and it ranks first (same group, REMUX)', kept(r)[0] === 'Oceans.Eleven.2001.1080p.BluRay.REMUX.AVC-EPSiLON', kept(r));
}
{
  const r = rankSubtitles([
    item('Schindlers.List.1993.Hybrid.2160p.UHD.Blu-ray.Remux-SoLaR', 'org.stremio.subsro'),
    item("Schindler's List (1993) BRRip", 'regielive'),
    item('Schindler.s.List.1993.1080p.BluRay.x264-GRP', 'subdl')
  ], { filename: "Schindler's List (1993) 2160p UHD BluRay REMUX HDR-GRP.mkv" });
  check("the 2160p remux 'Schindlers.List' is accepted for \"Schindler's List\"", kept(r).includes('Schindlers.List.1993.Hybrid.2160p.UHD.Blu-ray.Remux-SoLaR'), kept(r));
}
{
  const r = rankSubtitles([
    item('The.Office.(U.S.).S02E05.WEBRip.Netflix.ro', 'org.stremio.subsro'),
    item('The.Office.US.S02E05.720p.WEB-DL-GRP', 'subdl')
  ], { filename: 'The.Office.US.S02E05.Halloween.1080p.NF.WEB-DL.DDP5.1.x264-NTb.mkv', season: 2, episode: 5 });
  check('"(U.S.)" is the same show as "US"', kept(r).length === 2, kept(r));
}

// sequels, other films and other years are not the film
{
  const r = rankSubtitles([
    item('Oceans.Eleven.2001.1080p.BluRay-GRP'),
    item("Ocean's Thirteen"),
    item('Oceans.Twelve.2004.1080p.BluRay-GRP')
  ], { filename: 'Oceans.Eleven.2001.1080p.BluRay.x264-GRP.mkv' });
  check("Ocean's Thirteen and Twelve are not Eleven", kept(r).length === 1 && kept(r)[0].startsWith('Oceans.Eleven'), kept(r));
}
{
  const r = rankSubtitles([
    item('Toy.Story.3.2010.1080p.BluRay-GRP'),
    item('Toy.Story.2.1999.1080p.BluRay-GRP'),
    item('Toy.Story.2.1080p.BluRay-GRP')
  ], { filename: 'Toy.Story.3.2010.1080p.BluRay.x264-GRP.mkv' });
  check('Toy Story 2 is not Toy Story 3 (even without a year)', kept(r).length === 1, kept(r));
}
{
  const r = rankSubtitles([
    item('Black.Panther.Wakanda.Forever.2022.1080p.WEB-DL-GRP'),
    item('Black.Panther.2018.1080p.BluRay-GRP')
  ], { filename: 'Black.Panther.Wakanda.Forever.2022.1080p.WEB-DL.DDP5.1.x264-GRP.mkv' });
  check('Black Panther (2018) is not Wakanda Forever', kept(r).length === 1 && kept(r)[0].includes('Wakanda'), kept(r));
}
{
  const r = rankSubtitles([
    item('Scrubs.2026.S01E01.1080p.WEB-DL-GRP'),
    item('Scrubs.2001.S01E01.1080p.WEB-DL-GRP')
  ], { filename: 'Scrubs.2026.S01E01.2160p.HDR.mkv', season: 1, episode: 1 });
  check('a series of another year (Scrubs 2001) is another series', kept(r).length === 1 && kept(r)[0].includes('2026'), kept(r));
}

// a multi-part name (Wyzie) with junk parts: the junk is not a variant, and a rejected variant does not win
{
  const r = rankSubtitles([
    item('Zodiac.2007.DC.1080p.BluRay.x264-GRP; Translated by: DVD RETAIL x264 Uploaded by someone', 'wyzie')
  ], { filename: 'Zodiac.2007.1080p.BluRay.x264-GRP.mkv' });
  check('junk parts of a multi-part name do not turn it into another source', r.items.length === 1 && !r.details[0].rejected, r.details.map(d => d.reasons));
}
{
  const r = rankSubtitles([item('Marvel.Studios.Assembled.S02E02.The.Making.of.Guardians.of.the.Galaxy.Vol.3 [WEB-DL 3 variante]', 'org.stremio.subsro'),
    item('Guardians.of.the.Galaxy.Vol.3.2023.2160p.WEB-DL-GRP')], { filename: null });
  check('a variant without a title of its own does not bring a rejected name back', kept(r).length === 1, kept(r));
}

// anime / absolute numbering and OVAs
{
  const r = rankSubtitles([
    item('Naruto OVA 01 - Find the Four-Leaf Crimson Clover!', 'org.stremio.subsro'),
    item('Naruto - 001 - Enter Naruto Uzumaki!', 'subdl'),
    item('Naruto 1 - Intra! Uzumaki Naruto!', 'org.stremio.subsro'),
    item('[ANBU-AonE]_Naruto_94_[A5B8EC3C]', 'subdl')
  ], { filename: 'Naruto.001.v4.480p.DVD.Dual-Audio.FLAC2.0.Hi10P.x264-JySzE.mkv', season: 1, episode: 1 });
  check('Naruto 001: the OVA and episode 94 are out, the real episode is in', !kept(r).some(k => /OVA 01|_94_/.test(k)) && kept(r).includes('Naruto - 001 - Enter Naruto Uzumaki!'), kept(r));
}

// season packs, ranges, and codes written together
{
  const r = rankSubtitles([
    item('Friends.S03.WS.720p.BluRay.DD5.1.x264-GRP'),
    item('Friends.S02-10.1080p.BluRay-GRP'),
    item('Friends - 314 - The One With the Hypnosis Tape', 'regielive'),
    item('Friends.S03E15.720p.BluRay-GRP')
  ], { filename: 'Friends.S03E14.1080p.BluRay.x264-GRP.mkv', season: 3, episode: 14 });
  check('a season pack, a range holding S03 and "314" are the episode; S03E15 is not', kept(r).length === 3 && !kept(r).some(k => k.includes('S03E15')), kept(r));
}

// the parser
{
  const p = parseRelease('Friends.S03.720p.BluRay.DD5.1.x264');
  check('"DD5.1.x264" is not episode 264 of season 1', p.season === 3 && p.episode === null, p);
  check('a title with "Trial" or "Cam" is not a cam rip', parseRelease('The.Trial.of.the.Chicago.7.2020.1080p.BluRay.x264-GRP').source === 'bluray' && parseRelease('Cam.2018.1080p.WEB-DL').source === 'webdl');
  check('"Tears of the Amazon" is not Amazon', parseRelease('Tears.of.the.Amazon.2020.1080p.BluRay.x264-GRP').service === null);
  check('but a real Amazon tag is', parseRelease('Show.S01E01.1080p.AMZN.WEB-DL-GRP').service === 'amzn');
  check('an AMZN tag before the resolution is still Amazon', parseRelease('The.Mentalist.S01E01.AMZN.WEB-DL.1080p').service === 'amzn');
  check('TELESYNC before the resolution is still a cam rip', parseRelease('Inception.iNTERNAL.TELESYNC.720p.x264-ORC').source === 'cam');
  check('SKST and ATV are services', parseRelease('Tulsa.King.S02E10.SKST.WEB-DL').service === 'skst' && parseRelease('Dexter.S02E01.2160p.ATV.WEB-DL-GRP').service === 'atvp');
  check('the OpenSubtitles "-rum(1)" tag is not the group', parseRelease('Movie.2020.1080p.BluRay.DTS.x264-CtrlHD-rum(1)').group === 'ctrlhd');
  check('a name ending in .YIFY has the group yify', parseRelease('Movie.2020.1080p.BluRay.x264.YIFY').group === 'yify');
}

// deduplication keeps what differs in episode, year, resolution or group
{
  const merged = (a: string, b: string) => deduplicateSubtitles([item(a, 'a'), item(b, 'b')]).length === 1;
  check('the same release from two sources is merged', merged('Show.S02E05.1080p.WEB-DL.DDP5.1.H.264-NTb', 'Show.S02E05.1080p.WEB-DL.DDP5.1.H.264-NTb.ro'));
  check('S02E05 and S02E06 are not merged', !merged('Show.S02E05.1080p.WEB-DL.DDP5.1.H.264-NTb', 'Show.S02E06.1080p.WEB-DL.DDP5.1.H.264-NTb'));
  check('720p and 1080p of one group are not merged', !merged('Homecoming.S01E08.720p.AMZN.WEB-DL.DDP5.1.H.264-NTb', 'Homecoming.S01E08.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb'));
  check('two groups are not merged', !merged('Show.S01E01.720p.HDTV.x264-LOL', 'Show.S01E01.720p.HDTV.x264-DIMENSION'));
  check('two years are not merged', !merged('Movie.2019.1080p.BluRay.x264-GRP', 'Movie.2020.1080p.BluRay.x264-GRP'));
}

// the extra arguments of the request: decoded once
{
  const a = parseExtraSegment('videoHash=8e245d9679d31e12&videoSize=12909756&filename=Show.S01E01.DD%2B5.1.H.264-GRP.mkv.json');
  check('"%2B" in the file name stays a plus', a.filename === 'Show.S01E01.DD+5.1.H.264-GRP.mkv', a);
  check('hash and size are read', a.videoHash === '8e245d9679d31e12' && a.videoSize === '12909756');
  const b = parseExtraSegment('filename=Law%20%26%20Order.S01E01.mkv.json');
  check('"%26" in the file name stays an ampersand and does not cut the name', b.filename === 'Law & Order.S01E01.mkv', b);
  check('a bare "+" is a space (form encoding), "%20" too', parseExtraSegment('filename=Some+File%20Name.mkv.json').filename === 'Some File Name.mkv');
  check('a broken escape does not throw', parseExtraSegment('filename=100%.mkv.json').filename === '100%.mkv');
}
check('Subsource asks for the languages by name', subsourceLanguageNames(['ron', 'eng']) === 'romanian,english');
check('and for no filter when a language has no known name', subsourceLanguageNames(['ron', 'xyz']) === null);

if (failed) { console.error(`${failed} FAIL`); process.exit(1); }
console.log('matching: all ok');
