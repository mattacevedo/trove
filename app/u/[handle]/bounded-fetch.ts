// SSRF-bounded outbound fetch for the public verify path.
//
// This module is deliberately NOT a "use server" module: it exports non-async values
// (the `makeBoundedFetch` factory and the `boundedFetch` singleton). Next.js requires every
// export of a "use server" file to be an async Server Action, so these helpers must live
// outside `actions.ts` — which imports `boundedFetch` from here and re-exports nothing but its
// async action. Keeping this split is what lets `next build` succeed while preserving the exact
// SSRF mitigations below (see the public-reverify.test.ts suite, which imports from this module).

import net from "node:net";
import dns from "node:dns/promises";

/** Matches the shape of `dns.promises.lookup(host, { all: true })` — injectable for hermetic tests. */
export type DnsLookup = (
  host: string,
  opts: { all: true }
) => Promise<Array<{ address: string; family: number }>>;

/** Known cloud-metadata hostnames that must never be fetched, even though they are not literal IPs. */
const BLOCKED_HOSTS = new Set(["metadata.google.internal", "metadata"]);

/**
 * Canonical private/reserved-range block list, used by `isBlockedLiteralIp` below. `net.BlockList`
 * operates on the address's numeric value, not its textual form, so it blocks an IPv4-mapped IPv6
 * address (e.g. both the dotted `::ffff:169.254.169.254` AND the hex-compressed `::ffff:a9fe:a9fe`
 * forms) the same way it blocks the bare IPv4 literal — no separate regex/parsing of the mapped form
 * is needed. Verified empirically against Node's `net.BlockList` (see task report for the commands).
 */
const PRIVATE_BLOCK_LIST = new net.BlockList();
PRIVATE_BLOCK_LIST.addSubnet("0.0.0.0", 8, "ipv4");
PRIVATE_BLOCK_LIST.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE_BLOCK_LIST.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE_BLOCK_LIST.addSubnet("169.254.0.0", 16, "ipv4");
PRIVATE_BLOCK_LIST.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE_BLOCK_LIST.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE_BLOCK_LIST.addSubnet("::1", 128, "ipv6");
PRIVATE_BLOCK_LIST.addSubnet("fe80::", 10, "ipv6");
PRIVATE_BLOCK_LIST.addSubnet("fc00::", 7, "ipv6");
PRIVATE_BLOCK_LIST.addSubnet("::", 128, "ipv6");

/**
 * Reject a host that is a LITERAL IP address in a loopback / private / link-local / ULA range,
 * including IPv4-mapped IPv6 forms IN ANY TEXTUAL REPRESENTATION (dotted `::ffff:1.2.3.4` or
 * hex-compressed `::ffff:0102:0304`). Returns true when the host must be blocked. Hostnames that are
 * NOT literal IPs are NOT resolved here (see the DNS-rebinding deferral below) — they pass this
 * check and are handled only by the metadata-hostname denylist above.
 */
function isBlockedLiteralIp(host: string): boolean {
  // URL IPv6 hosts arrive bracketed (e.g. "[::1]"); strip brackets for net.isIP.
  const h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const fam = net.isIP(h);
  if (fam === 0) return false; // not a literal IP — a hostname
  return PRIVATE_BLOCK_LIST.check(h, fam === 6 ? "ipv6" : "ipv4");
}

/**
 * Bounded outbound fetch for the public verify path. The initial URL comes from earner-controlled
 * raw_json (detectHostedVerify()), so it is UNTRUSTED. Mitigations, applied in order BEFORE any
 * network call:
 *   - https-only: throws so an http/file/gopher URL can't be reached.
 *   - literal-private-IP / metadata-host block: parse the host and reject loopback / RFC1918 /
 *     link-local / ULA literal IPs (v4, v6, IPv4-mapped) and known metadata hostnames. This closes
 *     the direct SSRF class (e.g. https://169.254.169.254/, https://[::1]/, https://10.0.0.1/).
 *   - hostname->private-IP DNS-resolution block: when the host is NOT a literal IP, resolve it
 *     (via the injectable `lookup`, defaulting to `dns.promises.lookup`) and reject if ANY resolved
 *     address is a loopback/RFC1918/link-local/ULA literal (reusing `isBlockedLiteralIp`). A DNS
 *     lookup failure is ALSO treated as a rejection (fail closed) rather than silently proceeding.
 *     This closes the "stable-record" attack where an earner points a hosted-verify hostname at a
 *     DNS record that resolves to an internal/metadata address.
 *   - redirect: "manual": a redirect cannot transparently pivot into an internal address.
 *   - 5s AbortSignal.timeout: bounds a single request's duration.
 * DEFERRED (documented, NOT silently skipped): the resolve-then-fetch sequence is still a TOCTOU /
 * DNS-rebinding race — Node's fetch performs its own independent DNS resolution, so a resolver that
 * answers safely for our pre-flight `lookup` and then rebinds to a private address for the actual
 * connection is not caught here. A durable fix pins the resolved IP into the connection itself (e.g.
 * a custom dispatcher/agent) or routes egress through an allowlisted proxy. Per-IP / per-handle rate
 * limiting also does NOT exist yet (candidate follow-up: token bucket keyed by handle+credentialId).
 */
export function makeBoundedFetch(
  opts: { lookup: DnsLookup } = { lookup: dns.lookup as unknown as DnsLookup }
): typeof fetch {
  const { lookup } = opts;
  return async function boundedFetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`refusing unparseable verify fetch URL: ${raw}`);
    }
    if (parsed.protocol !== "https:") {
      throw new Error(`refusing non-https verify fetch: ${raw}`);
    }
    const host = parsed.hostname; // no brackets for IPv6 in .hostname
    if (BLOCKED_HOSTS.has(host.toLowerCase()) || isBlockedLiteralIp(host)) {
      throw new Error(`refusing verify fetch to blocked/private host: ${host}`);
    }
    // host is a hostname (not a literal IP, checked above) — resolve and vet every address.
    let resolved: Array<{ address: string; family: number }>;
    try {
      resolved = await lookup(host, { all: true });
    } catch (e) {
      throw new Error(`refusing verify fetch: DNS resolution failed for ${host}: ${(e as Error).message}`);
    }
    for (const { address } of resolved) {
      if (isBlockedLiteralIp(address)) {
        throw new Error(
          `refusing verify fetch to ${host}: resolves to blocked/private address ${address}`
        );
      }
    }
    return fetch(raw, { ...init, redirect: "manual", signal: AbortSignal.timeout(5000) });
  };
}

/** Default production instance: real DNS via `dns.promises.lookup`. */
export const boundedFetch = makeBoundedFetch();
