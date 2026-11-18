/**
 * The extra arguments of a Stremio request, "videoHash=..&videoSize=..&filename=..", read from the raw path segment.
 * Express has already decoded the segment once when it hands it over as a parameter; decoding it again turned a "+" of the
 * file name (DD+5.1, HDR10+) into a space and cut a name at an "&" (Law & Order). Here every value is decoded exactly
 * once: "%2B" is a plus, "%26" an ampersand, "%20" and a bare "+" a space (what a form encoder writes for it).
 */
export function parseExtraSegment(rawSegment: string): Record<string, string> {
  const out: Record<string, string> = {};
  const segment = rawSegment.replace(/\.json$/i, '');
  for (const pair of segment.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? '' : pair.slice(eq + 1);
    const decode = (v: string): string => {
      const spaced = v.replace(/\+/g, ' ');
      try { return decodeURIComponent(spaced); } catch { return spaced; }
    };
    const key = decode(rawKey);
    if (key) out[key] = decode(rawValue);
  }
  return out;
}
