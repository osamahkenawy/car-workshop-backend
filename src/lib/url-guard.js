/**
 * url-guard.js — SSRF protection for outbound requests to user-supplied URLs.
 *
 * Webhook endpoints are chosen by workshop admins, which makes them attacker
 * controlled from the server's point of view: the server will happily connect
 * to whatever it is given, from inside the network. That was enough to reach
 * the cloud metadata service (a delivery log recorded HTTP 405 from
 * http://169.254.169.254/latest/meta-data/).
 *
 * Blocking by hostname is not sufficient, because the name is resolved by the
 * HTTP client, not by us — "evil.example.com" can resolve to 169.254.169.254.
 * So the check is on the *resolved addresses*: every A/AAAA record must be a
 * public address, and the request is pinned to the address that was checked so
 * a second lookup cannot return something different (DNS rebinding).
 *
 * Redirects are not followed. A 302 to a private address would otherwise walk
 * straight past a check performed only on the original URL.
 */

import dns from 'node:dns/promises';
import net from 'node:net';

/** Only these schemes are ever dialled. */
const ALLOWED_PROTOCOLS = new Set(['https:', 'http:']);

/** Ports that are not HTTP services and have no business being a webhook. */
const BLOCKED_PORTS = new Set([
  22, 23, 25, 445, 993, 995, 1433, 1521, 3306, 3389, 5432, 5900, 6379, 9200, 11211, 27017,
]);

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

function inCidr(ip, cidr) {
  const [range, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(range) & mask);
}

// Everything that is not the public internet.
const BLOCKED_V4 = [
  '0.0.0.0/8',        // "this network"
  '10.0.0.0/8',       // RFC1918
  '100.64.0.0/10',    // CGNAT — includes 100.100.100.200 (Alibaba metadata)
  '127.0.0.0/8',      // loopback
  '169.254.0.0/16',   // link-local — includes 169.254.169.254 (AWS/GCP/Azure metadata)
  '172.16.0.0/12',    // RFC1918
  '192.0.0.0/24',     // IETF protocol assignments
  '192.0.2.0/24',     // TEST-NET-1
  '192.168.0.0/16',   // RFC1918
  '198.18.0.0/15',    // benchmarking
  '198.51.100.0/24',  // TEST-NET-2
  '203.0.113.0/24',   // TEST-NET-3
  '224.0.0.0/4',      // multicast
  '240.0.0.0/4',      // reserved, includes 255.255.255.255
];

/** True when the address must never be dialled. */
export function isBlockedAddress(addr) {
  let ip = String(addr).trim();

  // An IPv4-mapped address is the same destination as the IPv4 one, and it has
  // two spellings. WHATWG URL parsing normalises the dotted form to the hex
  // one, so ::ffff:169.254.169.254 arrives as ::ffff:a9fe:a9fe — checking only
  // the dotted spelling let the metadata service straight through.
  const mappedDotted = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mappedDotted) ip = mappedDotted[1];

  const mappedHex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    ip = [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
  }

  if (net.isIPv4(ip)) return BLOCKED_V4.some(cidr => inCidr(ip, cidr));

  if (net.isIPv6(ip)) {
    const v6 = ip.toLowerCase();
    if (v6 === '::1' || v6 === '::') return true;          // loopback / unspecified
    if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true;         // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(v6)) return true;         // fe80::/10 link-local
    if (/^ff[0-9a-f]{2}:/.test(v6)) return true;            // ff00::/8 multicast
    return false;
  }

  return true; // unparseable — refuse rather than guess
}

/**
 * Validate a user-supplied URL for outbound use.
 *
 * @param {string} rawUrl
 * @param {{ requireHttps?: boolean }} opts
 * @returns {Promise<{ url: URL, address: string, family: number }>} the resolved
 *          address that was checked, so the caller can pin the connection to it.
 * @throws {Error} with a message safe to show an admin editing the endpoint.
 */
export async function assertSafeOutboundUrl(rawUrl, { requireHttps = true } = {}) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new Error('Webhook URL is not a valid URL');
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error('Webhook URL must use http or https');
  }
  if (requireHttps && url.protocol !== 'https:') {
    throw new Error('Webhook URL must use https');
  }

  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  if (BLOCKED_PORTS.has(port)) {
    throw new Error(`Webhook URL may not target port ${port}`);
  }

  // A literal private address needs no DNS to be dangerous.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new Error('Webhook URL resolves to a private or reserved address');
    return { url, address: host, family: net.isIPv6(host) ? 6 : 4 };
  }

  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    throw new Error('Webhook URL host could not be resolved');
  }
  if (!records.length) throw new Error('Webhook URL host could not be resolved');

  // Every record must be public. One private answer among several is enough
  // for a round-robin to land somewhere internal.
  for (const r of records) {
    if (isBlockedAddress(r.address)) {
      throw new Error('Webhook URL resolves to a private or reserved address');
    }
  }

  return { url, address: records[0].address, family: records[0].family };
}

export default assertSafeOutboundUrl;
