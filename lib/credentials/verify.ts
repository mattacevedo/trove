import { importJWK, jwtVerify } from "jose";
import type {
  VerifyInput,
  VerifyOpts,
  VerifyResult,
} from "@/lib/credentials/types";
import { didKeyToPublicJwk } from "@/lib/credentials/did-key";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function result(
  status: VerifyResult["status"],
  method: VerifyResult["method"],
  detail: string
): VerifyResult {
  return { status, method, detail };
}

const HOSTED_TYPES = new Set(["hosted", "HostedBadge"]);

/**
 * Detect an OB2.x hosted verification target across both shapes:
 *   - Legacy OB1.1 / some OB2.0: { verify: { type:'hosted', url } } (top-level or under badge).
 *   - Canonical OB2.0: { verification: { type:'HostedBadge' | 'hosted' } } with the assertion
 *     URL carried in the top-level `id` (an https URL), NOT a verify.url field.
 * Returns the https re-fetch URL, or null when no hosted mechanism is present.
 */
export function detectHostedVerify(rawJson: unknown): { url: string } | null {
  const root = asRecord(rawJson);
  if (!root) return null;

  // Legacy verify.url shape (top-level or under badge).
  for (const holder of [root, asRecord(root.badge) ?? {}]) {
    const verify = asRecord((holder as Record<string, unknown>).verify);
    if (verify && typeof verify.url === "string" && verify.url.length > 0) {
      return { url: verify.url };
    }
  }

  // Canonical OB2.0: verification/verify block with a hosted type, URL in the top-level id.
  const verification =
    asRecord(root.verification) ?? asRecord(root.verify);
  const vType = verification && typeof verification.type === "string" ? verification.type : "";
  if (verification && HOSTED_TYPES.has(vType)) {
    const id = typeof root.id === "string" ? root.id : "";
    if (id.startsWith("http://") || id.startsWith("https://")) {
      return { url: id };
    }
  }
  return null;
}

/** A compact JWS: a bare "a.b.c" string, or nested under proof.jwt. */
export function detectJwt(rawJson: unknown): string | null {
  if (typeof rawJson === "string" && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(rawJson)) {
    return rawJson;
  }
  const root = asRecord(rawJson);
  const proof = asRecord(root?.proof);
  const jwt = proof?.jwt;
  if (typeof jwt === "string" && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(jwt)) return jwt;
  return null;
}

async function verifyJwt(jwt: string): Promise<VerifyResult> {
  try {
    const decodeHeader = (): Record<string, unknown> => {
      const [encodedHeader] = jwt.split(".");
      return JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
    };
    const header = decodeHeader();
    const kid = typeof header.kid === "string" ? header.kid : "";
    const jwk = didKeyToPublicJwk(kid);
    if (!jwk) {
      // Non-did:key (e.g. did:web) or missing kid: out of v1 scope — honest unverified.
      return result("unverified", "none", "unsupported verification method");
    }
    const key = await importJWK(jwk, "EdDSA");
    await jwtVerify(jwt, key); // throws on bad signature or expiry
    return result("verified", "vc_jwt", "did:key EdDSA signature valid");
  } catch (e) {
    return result("failed", "vc_jwt", (e as Error).message);
  }
}

/** The assertion's own identifier, used to confirm the hosted document is the SAME assertion. */
function assertionId(rawJson: unknown): string | null {
  const root = asRecord(rawJson);
  if (!root) return null;
  return typeof root.id === "string" && root.id.length > 0 ? root.id : null;
}

async function verifyHosted(
  url: string,
  storedId: string | null,
  fetchImpl: typeof fetch
): Promise<VerifyResult> {
  try {
    const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return result("failed", "ob2_hosted", `hosted fetch ${res.status}`);
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return result("failed", "ob2_hosted", "hosted response not JSON");
    if (body.revoked === true) return result("failed", "ob2_hosted", "revoked");
    // Identity match: the hosted document must be the SAME assertion we stored, not just
    // any reachable non-revoked JSON. Compare the stored assertion id (if any) against the
    // hosted body's own id. A mismatch means the URL points at an unrelated document -> failed.
    // Only enforced when the stored credential carries an id to compare against; when it has
    // none, we cannot prove identity, so we return honest `unverified` rather than false-verified.
    const hostedId = typeof body.id === "string" ? body.id : null;
    if (storedId) {
      if (hostedId && hostedId === storedId) {
        return result("verified", "ob2_hosted", "hosted assertion matches, not revoked");
      }
      return result(
        "failed",
        "ob2_hosted",
        `hosted id mismatch (stored ${storedId}, hosted ${hostedId ?? "none"})`
      );
    }
    return result(
      "unverified",
      "ob2_hosted",
      "hosted assertion reachable but no id to match against"
    );
  } catch (e) {
    return result("failed", "ob2_hosted", (e as Error).message);
  }
}

/**
 * Set a credential's honest verification status. Manual -> always unverified (no fetch).
 * Dispatch order: VC JWT crypto (did:key), then OB2.x hosted re-fetch, else unverified.
 */
export async function verifyCredential(
  input: VerifyInput,
  opts?: VerifyOpts
): Promise<VerifyResult> {
  if (input.source === "manual") {
    return result("unverified", "none", "manual entry");
  }
  const fetchImpl = opts?.fetchImpl ?? fetch;

  const jwt = detectJwt(input.raw_json);
  if (jwt) return verifyJwt(jwt);

  const hosted = detectHostedVerify(input.raw_json);
  if (hosted) return verifyHosted(hosted.url, assertionId(input.raw_json), fetchImpl);

  return result("unverified", "none", "no verifiable proof present");
}
