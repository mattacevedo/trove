// @vitest-environment node
// jose + multiformats hit a Buffer vs Uint8Array "separate realm" instanceof failure under
// jsdom (see did-key.test.ts / Task 4 notes). Run this file's crypto in a real Node realm.
import { beforeAll, expect, test, vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { base58btc } from "multiformats/bases/base58";
import { detectHostedVerify, detectJwt, verifyCredential } from "./verify";
import type { VerifyInput } from "@/lib/credentials/types";

// ---- OB2.x hosted detection + fetch path ----
test("detectHostedVerify finds legacy verify.url and badge.verify.url; null otherwise", () => {
  expect(detectHostedVerify({ verify: { type: "hosted", url: "https://x/a" } })).toEqual({
    url: "https://x/a",
  });
  expect(
    detectHostedVerify({ badge: { verify: { type: "hosted", url: "https://x/b" } } })
  ).toEqual({ url: "https://x/b" });
  expect(detectHostedVerify({ foo: 1 })).toBeNull();
});

test("detectHostedVerify handles canonical OB2.0 (verification:HostedBadge, url in id)", () => {
  expect(
    detectHostedVerify({
      id: "https://issuer.example/assertions/1",
      verification: { type: "HostedBadge" },
    })
  ).toEqual({ url: "https://issuer.example/assertions/1" });
  // A hosted verification block whose id is not an https URL has no re-fetch target.
  expect(
    detectHostedVerify({ id: "urn:uuid:abc", verification: { type: "hosted" } })
  ).toBeNull();
});

function fetchReturning(body: unknown, ok = true, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

// Canonical OB2.0 assertion carrying an id, so the identity match has something to compare.
const HOSTED_ASSERTION = {
  id: "https://issuer.example/assertions/1",
  verification: { type: "HostedBadge" },
};

test("hosted verify: reachable, id matches, not revoked -> verified", async () => {
  const input: VerifyInput = { source: "ob_url", raw_json: HOSTED_ASSERTION };
  const res = await verifyCredential(input, {
    fetchImpl: fetchReturning({ id: HOSTED_ASSERTION.id, revoked: false }),
  });
  expect(res.status).toBe("verified");
  expect(res.method).toBe("ob2_hosted");
});

test("hosted verify: reachable but hosted id is a DIFFERENT assertion -> failed", async () => {
  const input: VerifyInput = { source: "ob_url", raw_json: HOSTED_ASSERTION };
  const res = await verifyCredential(input, {
    // Reachable, not revoked, but an unrelated document — must NOT be verified.
    fetchImpl: fetchReturning({ id: "https://issuer.example/assertions/999", revoked: false }),
  });
  expect(res.status).toBe("failed");
});

test("hosted verify: legacy verify.url with no stored id -> unverified (cannot prove identity)", async () => {
  const input: VerifyInput = {
    source: "ob_url",
    raw_json: { verify: { type: "hosted", url: "https://issuer/a" } },
  };
  const res = await verifyCredential(input, {
    fetchImpl: fetchReturning({ revoked: false }),
  });
  // Reachable + not revoked, but no id to match against -> honest unverified, never verified.
  expect(res.status).toBe("unverified");
  expect(res.method).toBe("ob2_hosted");
});

test("hosted verify: revoked -> failed", async () => {
  const input: VerifyInput = { source: "ob_url", raw_json: HOSTED_ASSERTION };
  const res = await verifyCredential(input, {
    fetchImpl: fetchReturning({ id: HOSTED_ASSERTION.id, revoked: true }),
  });
  expect(res.status).toBe("failed");
});

test("hosted verify: fetch not ok (404) -> failed", async () => {
  const input: VerifyInput = { source: "ob_url", raw_json: HOSTED_ASSERTION };
  const res = await verifyCredential(input, {
    fetchImpl: fetchReturning({}, false, 404),
  });
  expect(res.status).toBe("failed");
});

test("hosted verify: fetch throws -> failed (never rejects)", async () => {
  const throwing = vi.fn(async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const res = await verifyCredential(
    { source: "ob_url", raw_json: HOSTED_ASSERTION },
    { fetchImpl: throwing }
  );
  expect(res.status).toBe("failed");
});

// ---- OB3.0/VC JWT crypto path (real keys, no network) ----
let signedVc: string;
let expiredVc: string;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  const rawX = Buffer.from(jwk.x as string, "base64url");
  const prefixed = Buffer.concat([Buffer.from([0xed, 0x01]), rawX]);
  const did = `did:key:${base58btc.encode(prefixed)}`;
  const kid = `${did}#${did.slice("did:key:".length)}`;

  signedVc = await new SignJWT({ vc: { type: ["VerifiableCredential"] } })
    .setProtectedHeader({ alg: "EdDSA", kid })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);

  expiredVc = await new SignJWT({ vc: {} })
    .setProtectedHeader({ alg: "EdDSA", kid })
    .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
    .sign(privateKey);
});

test("detectJwt finds a bare compact JWS and a proof.jwt; null otherwise", () => {
  expect(detectJwt("aaa.bbb.ccc")).toBe("aaa.bbb.ccc");
  expect(detectJwt({ proof: { jwt: "aaa.bbb.ccc" } })).toBe("aaa.bbb.ccc");
  expect(detectJwt({ credentialSubject: {} })).toBeNull();
});

test("VC JWT: valid signature (did:key) -> verified", async () => {
  const res = await verifyCredential({ source: "ob_url", raw_json: signedVc });
  expect(res.status).toBe("verified");
  expect(res.method).toBe("vc_jwt");
});

test("VC JWT: tampered payload -> failed", async () => {
  const parts = signedVc.split(".");
  const tampered = `${parts[0]}.${parts[1]}x.${parts[2]}`;
  const res = await verifyCredential({ source: "ob_url", raw_json: tampered });
  expect(res.status).toBe("failed");
});

test("VC JWT: expired -> failed", async () => {
  const res = await verifyCredential({ source: "ob_url", raw_json: expiredVc });
  expect(res.status).toBe("failed");
});

test("VC JWT: expiry is deterministic via injectable clock (not wall-clock dependent)", async () => {
  // signedVc has a 1h expiry set at beforeAll-time. Inject a clock far in the future,
  // well after that exp, so the expiry check is driven by opts.clock, not real time.
  const farFuture = () => new Date(Date.now() + 1000 * 60 * 60 * 24 * 365);
  const res = await verifyCredential(
    { source: "ob_url", raw_json: signedVc },
    { clock: farFuture }
  );
  expect(res.status).toBe("failed");
});

test("VC JWT: signed by key A but claimed kid is key B's did:key -> failed (not verified)", async () => {
  // Two distinct Ed25519 keypairs. Sign with A's private key, but publish a did:key/kid
  // derived from B's public key. A verifier that only checks "is this a valid EdDSA
  // signature under *some* key" would wrongly accept; the JWT's kid must be resolved to
  // its OWN public key and checked against THAT signature.
  const keyA = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const keyB = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });

  const jwkB = await exportJWK(keyB.publicKey);
  const rawXB = Buffer.from(jwkB.x as string, "base64url");
  const prefixedB = Buffer.concat([Buffer.from([0xed, 0x01]), rawXB]);
  const didB = `did:key:${base58btc.encode(prefixedB)}`;
  const kidB = `${didB}#${didB.slice("did:key:".length)}`;

  const wrongKeyJwt = await new SignJWT({ vc: { type: ["VerifiableCredential"] } })
    .setProtectedHeader({ alg: "EdDSA", kid: kidB }) // claims to be key B...
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(keyA.privateKey); // ...but is actually signed by key A.

  const res = await verifyCredential({ source: "ob_url", raw_json: wrongKeyJwt });
  expect(res.status).toBe("failed");
  expect(res.status).not.toBe("verified");
});

test("VC JWT: unsecured alg:none token -> not verified (downgrade rejected)", async () => {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ vc: { type: ["VerifiableCredential"] } })
  ).toString("base64url");
  const noneJwt = `${header}.${payload}.`; // empty signature segment

  const res = await verifyCredential({ source: "ob_url", raw_json: noneJwt });
  expect(res.status).not.toBe("verified");
});

// ---- honest fall-throughs ----
test("manual source is always unverified and never fetches", async () => {
  const fetchImpl = vi.fn() as unknown as typeof fetch;
  const res = await verifyCredential({ source: "manual", raw_json: null }, { fetchImpl });
  expect(res).toMatchObject({ status: "unverified", method: "none" });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("no proof and no hosted-verify block -> unverified", async () => {
  const res = await verifyCredential({
    source: "ob_file",
    raw_json: { credentialSubject: { achievement: { name: "X" } } },
  });
  expect(res.status).toBe("unverified");
});
