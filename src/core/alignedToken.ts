/** What the link of an aligned subtitle carries (base64url JSON in the path) */
export interface AlignedToken {
  /** the real subtitle link (ours, or an allowed one) */
  u: string;
  /** backup links of the same subtitle (other providers), tried in order when `u` cannot be downloaded */
  b?: string[];
  /** content id ("tt13146488:1:1") and type */
  id: string;
  t?: string;
  /** name of the playing file */
  f: string;
  /** release name of the subtitle (for the Debug page) */
  r?: string;
  /** next subtitles of the same language, tried in order when this one does not fit the references */
  a?: Array<{ u: string; r?: string; b?: string[] }>;
}

/** What the link of a subtitle with backup sources carries (no alignment): the links, tried in order */
export interface FallbackToken {
  u: string;
  b: string[];
  r?: string;
}

/** How many alternatives a link carries */
export const MAX_ALTERNATIVES = 3;
/** How many backup sources one subtitle carries */
export const MAX_BACKUPS = 2;

const urlList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX_BACKUPS) : undefined;

export function encodeAlignedToken(token: AlignedToken): string {
  return Buffer.from(JSON.stringify(token)).toString('base64url');
}

export function decodeAlignedToken(data: string): AlignedToken | null {
  try {
    const t = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!t || typeof t.u !== 'string' || typeof t.id !== 'string' || typeof t.f !== 'string') return null;
    t.b = urlList(t.b);
    t.a = Array.isArray(t.a)
      ? t.a.filter((x: unknown) => x && typeof (x as { u?: unknown }).u === 'string').slice(0, MAX_ALTERNATIVES)
        .map((x: { u: string; r?: string; b?: unknown }) => ({ u: x.u, r: x.r, b: urlList(x.b) }))
      : undefined;
    return t as AlignedToken;
  } catch {
    return null;
  }
}

export function encodeFallbackToken(token: FallbackToken): string {
  return Buffer.from(JSON.stringify(token)).toString('base64url');
}

export function decodeFallbackToken(data: string): FallbackToken | null {
  try {
    const t = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!t || typeof t.u !== 'string') return null;
    return { u: t.u, b: urlList(t.b) || [], r: typeof t.r === 'string' ? t.r : undefined };
  } catch {
    return null;
  }
}

/** The links of one subtitle, first the main one, then its backups */
export const linksOf = (t: { u: string; b?: string[] }): string[] => [t.u, ...(t.b || [])];
