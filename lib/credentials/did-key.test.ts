import { expect, test } from "vitest";
import { generateKeyPair, exportJWK } from "jose";
import { base58btc } from "multiformats/bases/base58";
import { didKeyToPublicJwk } from "./did-key";

// Build a did:key from a freshly generated Ed25519 public key, then round-trip it.
async function makeDidKey(): Promise<{ did: string; expectedX: string }> {
  const { publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const jwk = await exportJWK(publicKey);
  const rawX = Buffer.from(jwk.x as string, "base64url"); // 32-byte Ed25519 public key
  // multicodec prefix for ed25519-pub is 0xed 0x01
  const prefixed = Buffer.concat([Buffer.from([0xed, 0x01]), rawX]);
  // multiformats' encoder does a strict `instanceof Uint8Array` check, which a Node
  // Buffer fails under jsdom's separate Uint8Array realm — normalize to a plain
  // Uint8Array so the fixture works regardless of test environment.
  const did = `did:key:${base58btc.encode(new Uint8Array(prefixed))}`;
  return { did, expectedX: jwk.x as string };
}

test("decodes a did:key Ed25519 verificationMethod to a matching JWK", async () => {
  const { did, expectedX } = await makeDidKey();
  const jwk = didKeyToPublicJwk(`${did}#${did.slice("did:key:".length)}`);
  expect(jwk).not.toBeNull();
  expect(jwk!.kty).toBe("OKP");
  expect(jwk!.crv).toBe("Ed25519");
  expect(jwk!.x).toBe(expectedX);
});

test("accepts a bare did:key without a fragment", async () => {
  const { did, expectedX } = await makeDidKey();
  expect(didKeyToPublicJwk(did)!.x).toBe(expectedX);
});

test("returns null for non-did:key methods and malformed input", () => {
  expect(didKeyToPublicJwk("did:web:issuer.example")).toBeNull();
  expect(didKeyToPublicJwk("not-a-did")).toBeNull();
  expect(didKeyToPublicJwk("did:key:zNotBase58!!!")).toBeNull();
  expect(didKeyToPublicJwk("")).toBeNull();
});
