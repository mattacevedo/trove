"use server";

import net from "node:net";
import { createServerClient } from "@/lib/supabase/server";
import { verifyCredential } from "@/lib/credentials/verify";
import type { VerifyResult, CredentialSource } from "@/lib/credentials/types";

/** Known cloud-metadata hostnames that must never be fetched, even though they are not literal IPs. */
const BLOCKED_HOSTS = new Set(["metadata.google.internal", "metadata"]);

/**
 * Reject a host that is a LITERAL IP address in a loopback / private / link-local / ULA range,
 * including IPv4-mapped IPv6 forms. Returns true when the host must be blocked. Hostnames that are
 * NOT literal IPs are NOT resolved here (see the DNS-rebinding deferral below) — they pass this
 * check and are handled only by the metadata-hostname denylist above.
 */
function isBlockedLiteralIp(host: string): boolean {
  // URL IPv6 hosts arrive bracketed (e.g. "[::1]"); strip brackets for net.isIP.
  const h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const fam = net.isIP(h);
  if (fam === 0) return false; // not a literal IP — a hostname

  if (fam === 4) {
    const [a, b] = h.split(".").map((n) => Number(n));
    if (a === 127) return true;                    // 127.0.0.0/8 loopback
    if (a === 10) return true;                     // 10.0.0.0/8
    if (a === 192 && b === 168) return true;       // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 169 && b === 254) return true;       // 169.254.0.0/16 link-local (incl. cloud metadata)
    if (a === 0) return true;                       // 0.0.0.0/8
    return false;
  }

  // IPv6
  const lower = h.toLowerCase();
  if (lower === "::1" || lower === "::") return true;               // loopback / unspecified
  if (lower.startsWith("fe8") || lower.startsWith("fe9") ||
      lower.startsWith("fea") || lower.startsWith("feb")) return true; // fe80::/10 link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;   // fc00::/7 unique-local
  // IPv4-mapped IPv6 (e.g. ::ffff:169.254.169.254) — re-check the embedded v4 literal.
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped && isBlockedLiteralIp(mapped[1])) return true;
  return false;
}

/**
 * Bounded outbound fetch for the public verify path. The initial URL comes from earner-controlled
 * raw_json (detectHostedVerify()), so it is UNTRUSTED. Mitigations, applied in order BEFORE any
 * network call:
 *   - https-only: throws so an http/file/gopher URL can't be reached.
 *   - literal-private-IP / metadata-host block: parse the host and reject loopback / RFC1918 /
 *     link-local / ULA literal IPs (v4, v6, IPv4-mapped) and known metadata hostnames. This closes
 *     the direct SSRF class (e.g. https://169.254.169.254/, https://[::1]/, https://10.0.0.1/).
 *   - redirect: "manual": a redirect cannot transparently pivot into an internal address.
 *   - 5s AbortSignal.timeout: bounds a single request's duration.
 * DEFERRED (documented, NOT silently skipped): a HOSTNAME that legitimately resolves via DNS to a
 * private IP (DNS-rebinding / attacker resolver) is still reachable — Node fetch does not expose the
 * resolved IP and this path adds no pre-resolve dns.lookup guard. Follow-up: dns.lookup + block
 * private results, or an egress allowlist/proxy. Per-IP / per-handle rate limiting also does NOT
 * exist yet (candidate follow-up: token bucket keyed by handle+credentialId).
 */
export async function boundedFetch(
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
  return fetch(raw, { ...init, redirect: "manual", signal: AbortSignal.timeout(5000) });
}

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
