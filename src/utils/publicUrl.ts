import dns from 'dns';
import net from 'net';

/**
 * Only public addresses may be fetched on behalf of a visitor (an addon's address, a manifest to validate, a subtitle
 * link of an imported addon): never the machine itself or an internal network (loopback, 10.x, 172.16-31.x, 192.168.x,
 * link-local 169.254.x where cloud hosts keep their credentials, unique-local IPv6...). The name is resolved and every
 * address it gives must be public. (A name that does not resolve is let through: the request itself fails then.)
 * Tests that serve from 127.0.0.1 set ALLOW_PRIVATE_HOSTS=1.
 */

export function isPrivateAddress(address: string): boolean {
  let ip = address.trim().toLowerCase();
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) ip = mapped[1];
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    return ip === '::' || ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || /^ff/.test(ip);
  }
  return false;
}

/** A name that is private by what it says (no lookup needed) */
function privateByName(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') ||
    h.endsWith('.lan') || h.endsWith('.home.arpa') || isPrivateAddress(h);
}

const checked = new Map<string, { ok: boolean; at: number }>();
const CHECK_TTL_MS = 5 * 60 * 1000;
const allowPrivate = (): boolean => process.env.ALLOW_PRIVATE_HOSTS === '1';

/** Throws when the address is not http(s) or leads to a private address */
export async function assertPublicUrl(url: string): Promise<void> {
  if (allowPrivate()) return;
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('not a valid address'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('only http and https addresses are fetched');
  const host = parsed.hostname;
  if (privateByName(host)) throw new Error('the address is not public');
  if (net.isIP(host.replace(/^\[|\]$/g, ''))) return; // a public IP literal
  const known = checked.get(host);
  if (known && Date.now() - known.at < CHECK_TTL_MS) {
    if (!known.ok) throw new Error('the address is not public');
    return;
  }
  let ok = true;
  try {
    const found = await dns.promises.lookup(host, { all: true });
    ok = !found.some(f => isPrivateAddress(f.address));
  } catch {
    ok = true; // does not resolve: the request fails by itself
  }
  if (checked.size > 500) checked.clear();
  checked.set(host, { ok, at: Date.now() });
  if (!ok) throw new Error('the address is not public');
}

/** For axios' beforeRedirect (synchronous): a redirect to a private name or IP literal is refused */
export function refuseRedirectToPrivate(hostname: string | undefined): void {
  if (allowPrivate()) return;
  if (hostname && privateByName(hostname)) throw new Error('Redirect to an address that is not public');
}
