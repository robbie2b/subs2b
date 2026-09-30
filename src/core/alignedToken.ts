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
}

export function encodeAlignedToken(token: AlignedToken): string {
  return Buffer.from(JSON.stringify(token)).toString('base64url');
}

export function decodeAlignedToken(data: string): AlignedToken | null {
  try {
    const t = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    return t && typeof t.u === 'string' && typeof t.id === 'string' && typeof t.f === 'string' ? t as AlignedToken : null;
  } catch {
    return null;
  }
}
