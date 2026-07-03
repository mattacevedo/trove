import { afterEach, expect, test, vi } from "vitest";
import type { VerifyResult } from "@/lib/credentials/types";

// --- Mocks: an injectable Supabase stub and the pure verifier. ---
// The action joins credentials -> earners on the viewed handle, so the query chain is
// .from("credentials").select(...).eq("id", credentialId).eq("earners.handle", handle).maybeSingle().
// The stub returns `maybeSingle` at the end of a chain of .eq()s regardless of arity.
const maybeSingle = vi.fn();
const update = vi.fn(() => {
  throw new Error("publicReverifyCredential must NEVER write");
});
const eq = vi.fn(() => chain);
const chain: { eq: typeof eq; maybeSingle: typeof maybeSingle } = { eq, maybeSingle };
const from = vi.fn(() => ({
  select: () => chain,
  update, // wired to throw if the action ever calls it
}));
vi.mock("@/lib/supabase/server", () => ({
  createServerClient: async () => ({ from }),
}));

// vitest 4's vi.fn<T>() takes a single function-type argument (not <Args, Return>).
const verifyCredential = vi.fn<() => Promise<VerifyResult>>();
vi.mock("@/lib/credentials/verify", () => ({
  verifyCredential: (...args: unknown[]) =>
    (verifyCredential as (...a: unknown[]) => Promise<VerifyResult>)(...args),
}));

afterEach(() => {
  maybeSingle.mockReset();
  update.mockClear();
  eq.mockClear();
  verifyCredential.mockReset();
  from.mockClear();
});

test("returns null and never verifies when no row is visible (private/nonexistent/wrong handle)", async () => {
  maybeSingle.mockResolvedValue({ data: null });
  const { publicReverifyCredential } = await import("./actions");
  await expect(publicReverifyCredential("alice", "cred-1")).resolves.toBeNull();
  expect(verifyCredential).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});

test("happy path returns the VerifyResult and never writes", async () => {
  maybeSingle.mockResolvedValue({
    data: { id: "cred-1", source: "ob_url", raw_json: { id: "https://x/a" } },
  });
  const expected: VerifyResult = { status: "verified", method: "ob2_hosted", detail: "ok" };
  verifyCredential.mockResolvedValue(expected);
  const { publicReverifyCredential } = await import("./actions");
  await expect(publicReverifyCredential("alice", "cred-1")).resolves.toEqual(expected);
  expect(verifyCredential).toHaveBeenCalledTimes(1);
  // The query is scoped to BOTH the credential id AND the viewed handle (defense-in-depth).
  expect(eq).toHaveBeenCalledWith("id", "cred-1");
  expect(eq).toHaveBeenCalledWith("earners.handle", "alice");
  // The bounded fetch must be injected as opts.fetchImpl.
  const opts = (verifyCredential.mock.calls[0] as unknown[])[1] as { fetchImpl?: unknown };
  expect(typeof opts.fetchImpl).toBe("function");
  expect(update).not.toHaveBeenCalled();
});

test("boundedFetch throws synchronously on a non-https URL before any network call", async () => {
  const spy = vi.spyOn(globalThis, "fetch");
  const { boundedFetch } = await import("./bounded-fetch");
  await expect(boundedFetch("http://internal/metadata")).rejects.toThrow(/https/i);
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

test("boundedFetch rejects literal private/loopback/link-local/metadata hosts before any network call", async () => {
  const spy = vi.spyOn(globalThis, "fetch");
  const { boundedFetch } = await import("./bounded-fetch");
  for (const url of [
    "https://169.254.169.254/latest/meta-data/", // link-local / cloud metadata
    "https://[::1]/",                              // IPv6 loopback
    "https://127.0.0.1/",                          // IPv4 loopback
    "https://10.0.0.1/",                           // RFC1918
    "https://192.168.1.1/",                        // RFC1918
    "https://172.16.0.1/",                         // RFC1918
    "https://metadata.google.internal/",           // known metadata hostname
  ]) {
    await expect(boundedFetch(url)).rejects.toThrow(/private|blocked|refus|internal|metadata/i);
  }
  expect(spy).not.toHaveBeenCalled(); // NONE of them reached the network
  spy.mockRestore();
});

test("boundedFetch rejects IPv4-mapped IPv6 private addresses in EVERY textual form (dotted, hex-compressed, bare)", async () => {
  const spy = vi.spyOn(globalThis, "fetch");
  const { boundedFetch } = await import("./bounded-fetch");
  for (const url of [
    "https://169.254.169.254/",        // bare IPv4
    "https://[::ffff:169.254.169.254]/", // IPv4-mapped IPv6, dotted form
    "https://[::ffff:a9fe:a9fe]/",       // IPv4-mapped IPv6, hex-compressed form (the specific gap)
    "https://[::1]/",                    // IPv6 loopback
    "https://[fe80::1]/",                // IPv6 link-local
    "https://[fc00::1]/",                // IPv6 unique-local
  ]) {
    await expect(boundedFetch(url)).rejects.toThrow(/private|blocked|refus|internal|metadata/i);
  }
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

test("isBlockedLiteralIp does not block a normal public IPv4 address", async () => {
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}", { status: 200 }));
  const { makeBoundedFetch } = await import("./bounded-fetch");
  const boundedFetch = makeBoundedFetch({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  await boundedFetch("https://93.184.216.34/");
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
});

test("boundedFetch rejects a hostname whose DNS resolution returns a hex-compressed IPv4-mapped IPv6 private address, before any fetch", async () => {
  const spy = vi.spyOn(globalThis, "fetch");
  const { makeBoundedFetch } = await import("./bounded-fetch");
  const boundedFetch = makeBoundedFetch({
    lookup: async () => [{ address: "::ffff:a9fe:a9fe", family: 6 }],
  });
  await expect(boundedFetch("https://evil.example/verify")).rejects.toThrow(
    /private|blocked|refus|internal|resolves/i
  );
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

test("boundedFetch passes redirect:manual and an AbortSignal to the underlying fetch for a public https host", async () => {
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}", { status: 200 }));
  const { makeBoundedFetch } = await import("./bounded-fetch");
  const boundedFetch = makeBoundedFetch({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  await boundedFetch("https://issuer.example/a", { headers: { Accept: "application/json" } });
  const init = spy.mock.calls[0][1] as RequestInit;
  expect(init.redirect).toBe("manual");
  expect(init.signal).toBeInstanceOf(AbortSignal);
  spy.mockRestore();
});

test("boundedFetch rejects a hostname that DNS-resolves to a private/link-local/loopback address, before any fetch", async () => {
  const spy = vi.spyOn(globalThis, "fetch");
  const { makeBoundedFetch } = await import("./bounded-fetch");
  for (const address of ["169.254.169.254", "10.0.0.1", "::1"]) {
    const boundedFetch = makeBoundedFetch({
      lookup: async () => [{ address, family: net_family(address) }],
    });
    await expect(boundedFetch("https://evil.example/verify")).rejects.toThrow(
      /private|blocked|refus|internal|resolves/i
    );
  }
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

test("boundedFetch proceeds to fetch when the hostname DNS-resolves to a public address", async () => {
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}", { status: 200 }));
  const { makeBoundedFetch } = await import("./bounded-fetch");
  const boundedFetch = makeBoundedFetch({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  await boundedFetch("https://issuer.example/a");
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
});

test("boundedFetch fails closed (rejects, does not fetch) when DNS lookup itself throws", async () => {
  const spy = vi.spyOn(globalThis, "fetch");
  const { makeBoundedFetch } = await import("./bounded-fetch");
  const boundedFetch = makeBoundedFetch({
    lookup: async () => {
      throw new Error("ENOTFOUND");
    },
  });
  await expect(boundedFetch("https://issuer.example/a")).rejects.toThrow(/dns|refus/i);
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

test("boundedFetch (default export) still rejects literal private IPs without invoking the resolver", async () => {
  // Literal IPs must short-circuit on isBlockedLiteralIp and never reach the DNS lookup step.
  const spy = vi.spyOn(globalThis, "fetch");
  const { boundedFetch } = await import("./bounded-fetch");
  await expect(boundedFetch("https://169.254.169.254/")).rejects.toThrow(/private|blocked|refus/i);
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

function net_family(address: string): number {
  return address.includes(":") ? 6 : 4;
}
