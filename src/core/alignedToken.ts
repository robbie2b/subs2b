/** What the link of an aligned subtitle carries (base64url JSON in the path) */
export interface AlignedToken {
  /** the real subtitle link (ours, or an allowed one) */
  u: string;
  /** content id ("tt13146488:1:1") and type */
  id: string;
  t?: string;
  /** name of the playing file */
  f: string;
  /** release name of the subtitle (for the Debug page) */
  r?: string;
  /** next subtitles of the same language, tried in order when this one does not fit the references */
  a?: Array<{ u: string; r?: string }>;
}

/** How many alternatives a link carries */
export const MAX_ALTERNATIVES = 3;

export function encodeAlignedToken(token: AlignedToken): string {
  return Buffer.from(JSON.stringify(token)).toString('base64url');
}

export function decodeAlignedToken(data: string): AlignedToken | null {
  try {
    const t = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!t || typeof t.u !== 'string' || typeof t.id !== 'string' || typeof t.f !== 'string') return null;
    t.a = Array.isArray(t.a)
      ? t.a.filter((x: unknown) => x && typeof (x as { u?: unknown }).u === 'string').slice(0, MAX_ALTERNATIVES)
      : undefined;
    return t as AlignedToken;
  } catch {
    return null;
  }
}
