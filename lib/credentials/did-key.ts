import { base58btc } from "multiformats/bases/base58";

export interface Ed25519Jwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string; // base64url of the 32-byte public key
}

// multicodec varint prefix for ed25519-pub is [0xed, 0x01].
const ED25519_PREFIX = [0xed, 0x01];

/**
 * Decode a `did:key` Ed25519 verification method into an Ed25519 public JWK.
 * Returns null for any non-did:key, non-Ed25519, or malformed input. Pure, no I/O.
 */
export function didKeyToPublicJwk(verificationMethod: string): Ed25519Jwk | null {
  if (typeof verificationMethod !== "string") return null;
  // Strip an optional DID-URL fragment (#...).
  const did = verificationMethod.split("#")[0];
  const prefix = "did:key:";
  if (!did.startsWith(prefix)) return null;
  const multibase = did.slice(prefix.length);
  if (!multibase.startsWith("z")) return null; // z = base58btc multibase

  let decoded: Uint8Array;
  try {
    decoded = base58btc.decode(multibase);
  } catch {
    return null;
  }
  if (decoded.length !== ED25519_PREFIX.length + 32) return null;
  if (decoded[0] !== ED25519_PREFIX[0] || decoded[1] !== ED25519_PREFIX[1]) return null;

  const raw = decoded.slice(ED25519_PREFIX.length);
  const x = Buffer.from(raw).toString("base64url");
  return { kty: "OKP", crv: "Ed25519", x };
}
