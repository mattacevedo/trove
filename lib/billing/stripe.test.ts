import { expect, test, vi } from "vitest";
import { createStripeClient, STRIPE_API_VERSION, planForPriceId } from "./stripe";
import type { StripeLike } from "./types";

/** A fully-typed hand-written fake StripeLike — no real SDK, no network, no key. */
function fakeStripe(): StripeLike {
  return {
    customers: { create: vi.fn().mockResolvedValue({ id: "cus_fake" }) },
    checkout: {
      sessions: {
        create: vi.fn().mockResolvedValue({ id: "cs_fake", url: "https://stripe.test/checkout" }),
      },
    },
    billingPortal: {
      sessions: { create: vi.fn().mockResolvedValue({ url: "https://stripe.test/portal" }) },
    },
    subscriptions: {
      retrieve: vi
        .fn()
        .mockResolvedValue({ id: "sub_fake", status: "active", items: { data: [{ id: "si_fake", quantity: 1 }] } }),
      update: vi.fn().mockResolvedValue({ id: "sub_fake" }),
    },
    invoices: { list: vi.fn().mockResolvedValue({ data: [] }) },
    webhooks: {
      constructEvent: vi
        .fn()
        .mockReturnValue({ id: "evt_fake", created: 0, type: "noop", data: { object: {} } }),
    },
  };
}

test("pins a real Stripe apiVersion literal", () => {
  expect(STRIPE_API_VERSION).toBe("2025-06-30.basil");
});

test("planForPriceId falls back to 'free' for an unknown or absent price id", () => {
  // No env price is stubbed, so an arbitrary id is unmapped and must fall back to 'free'.
  expect(planForPriceId("price_not_in_map")).toBe("free");
  expect(planForPriceId(null)).toBe("free");
  expect(planForPriceId(undefined)).toBe("free");
});

test("returns the injected client as-is (never constructs a real Stripe)", () => {
  const injected = fakeStripe();
  const client = createStripeClient({ client: injected });
  // Identity: the injected fake is handed straight back — proves construction was short-circuited.
  expect(client).toBe(injected);
});

test("does NOT read the Stripe secret key env var when a client is injected", () => {
  // If construction were attempted, the real Stripe SDK would read the secret key env var.
  // Injection must bypass that entirely — so with the key unset, injection must still succeed.
  // We use vi.stubEnv/vi.unstubAllEnvs (never a literal read/assign of that env var) so the
  // Task 14 grep-guard, which flags a genuine READ of the secret, stays green.
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  try {
    const injected = fakeStripe();
    // Must not throw despite the empty key, because we inject and never build a real client.
    const client = createStripeClient({ client: injected });
    expect(client).toBe(injected);
  } finally {
    vi.unstubAllEnvs();
  }
});

test("the injected fake exposes the full StripeLike surface used by later tasks", async () => {
  const client = createStripeClient({ client: fakeStripe() });
  await expect(client.customers.create({})).resolves.toEqual({ id: "cus_fake" });
  await expect(client.checkout.sessions.create({})).resolves.toEqual({
    id: "cs_fake",
    url: "https://stripe.test/checkout",
  });
  await expect(client.billingPortal.sessions.create({})).resolves.toEqual({
    url: "https://stripe.test/portal",
  });
  await expect(client.subscriptions.retrieve("sub_fake")).resolves.toMatchObject({
    id: "sub_fake",
    status: "active",
  });
  await expect(client.subscriptions.update("sub_fake", {})).resolves.toEqual({ id: "sub_fake" });
  await expect(client.invoices.list({})).resolves.toEqual({ data: [] });
  expect(client.webhooks.constructEvent("{}", "sig", "whsec_fake")).toEqual({
    id: "evt_fake",
    created: 0,
    type: "noop",
    data: { object: {} },
  });
});
