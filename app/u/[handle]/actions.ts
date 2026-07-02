"use server";

import net from "node:net";
import dns from "node:dns/promises";
import { createServerClient } from "@/lib/supabase/server";
import { verifyCredential } from "@/lib/credentials/verify";
import type { VerifyResult, CredentialSource } from "@/lib/credentials/types";

/** Matches the shape of `dns.promises.lookup(host, { all: true })` — injectable for hermetic tests. */
type DnsLookup = (
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

/**
 * READ-ONLY on-demand re-verify for anonymous public-profile viewers (spec §5). Re-loads raw_json
 * through the anon-RLS path (credentials_public_select, 0005 — inherits the public_profile_enabled
 * gate), JOINED to the viewed handle so a viewer can only re-verify credentials on the profile they
 * are on (defense-in-depth; shrinks the SSRF trigger set). Runs the unmodified verifyCredential with
 * the bounded fetch and RETURNS the transient result for display. It NEVER calls .update()/.upsert():
 * anon has no write policy, and persisting a viewer-triggered status would be wrong. Returns null
 * when no matching row is visible (private, nonexistent, or belongs to a different handle).
 */
export async function publicReverifyCredential(
  handle: string,
  credentialId: string
): Promise<VerifyResult | null> {
  const supabase = await createServerClient();
  // The embedded !inner join filters credentials to those whose parent earner has this handle;
  // combined with credentials_public_select (0005), only published credentials on THIS profile match.
  const { data: cred } = await supabase
    .from("credentials")
    .select("id, source, raw_json, earners!inner(handle)")
    .eq("id", credentialId)
    .eq("earners.handle", handle)
    .maybeSingle();
  if (!cred) return null;

  return verifyCredential(
    { source: cred.source as CredentialSource, raw_json: cred.raw_json ?? null },
    { fetchImpl: boundedFetch }
  );
}
