// Owner: Orchestrator. Which reverse proxies the API believes about the client address (CP5-02).
import { isIP } from 'node:net';

/** Express `trust proxy` value: false (trust nobody), a hop count, or a list of addresses/subnets. */
export type TrustProxySetting = false | number | string[];

const NAMED = new Set(['loopback', 'linklocal', 'uniquelocal']);

/**
 * Parses SMS_TRUST_PROXY.
 * - unset, "", "false" or "0": trust no proxy. req.ip is the socket address and X-Forwarded-For is ignored.
 *   This is the safe default when the API is reached directly.
 * - a whole number N (production Compose uses 1): trust the last N hops. With 1, req.ip is the address that
 *   Caddy put in X-Forwarded-For; anything the browser itself sent in that header is not believed.
 * - a comma-separated list of IP addresses, CIDR subnets or the names loopback / linklocal / uniquelocal.
 * "true" (trust every hop) is refused: any client could then choose its own address.
 */
export function parseTrustProxy(raw: string | undefined): TrustProxySetting {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'false' || v === '0') return false;
  if (v === 'true') throw new Error('SMS_TRUST_PROXY=true would let any client choose its own IP address; use the number of proxy hops (1 behind Caddy) or the proxy subnet');
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    if (n > 10) throw new Error(`SMS_TRUST_PROXY=${v} is not a sensible number of proxy hops`);
    return n;
  }
  const items = v.split(',').map((s) => s.trim()).filter(Boolean);
  for (const item of items) {
    if (NAMED.has(item)) continue;
    const [addr, bits, extra] = item.split('/');
    const family = isIP(addr ?? '');
    const maxBits = family === 6 ? 128 : 32;
    const bitsOk = bits === undefined || (/^\d+$/.test(bits) && Number(bits) <= maxBits);
    if (!family || !bitsOk || extra !== undefined) throw new Error(`SMS_TRUST_PROXY: "${item}" is not an IP address, subnet or one of loopback, linklocal, uniquelocal`);
  }
  return items;
}
