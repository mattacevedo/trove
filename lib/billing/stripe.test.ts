import { expect, test, vi } from "vitest";
import { createStripeClient, STRIPE_API_VERSION, planForPriceId } from "./stripe";
import { createPortalSession, listInvoices } from "./portal";
import type { StripeLike } from "./types";

// A hand-written fake DB that returns a canned sponsors row for the .from("sponsors")
// single()-style read the billing helpers perform, and records any update() it receives.
// Mirrors the injectable-fake approach of lib/advisor/llm.test.ts — no Supabase, no network.
function fakeDb(sponsorRow: Record<string, unknown>) {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    from(table: string) {
      if (table !== "sponsors") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: sponsorRow, error: null }),
            single: async () => ({ data: sponsorRow, error: null }),
          }),
        }),
        update(patch: Record<string, unknown>) {
          updates.push(patch);
          return { eq: async () => ({ data: null, error: null }) };
        },
      };
    },
  };
  return { db: db as unknown as import("@supabase/supabase-js").SupabaseClient, updates };
}

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

test("createStripeClient returns the injected client unchanged (no real SDK constructed)", () => {
  const fake: StripeLike = {
    customers: { create: vi.fn() },
    checkout: { sessions: { create: vi.fn() } },
    billingPortal: { sessions: { create: vi.fn() } },
    subscriptions: { retrieve: vi.fn(), update: vi.fn() },
    invoices: { list: vi.fn() },
    webhooks: { constructEvent: vi.fn() },
  } as unknown as StripeLike;
  expect(createStripeClient({ client: fake })).toBe(fake);
});

test("createPortalSession ensures a customer then creates a portal session for that customer", async () => {
  // Sponsor already has a customer id, so ensureStripeCustomer must NOT create a new one.
  const { db } = fakeDb({
    id: "sp1",
    name: "Acme",
    plan: "team",
    seats: 5,
    stripe_customer_id: "cus_existing",
    stripe_subscription_id: "sub_1",
    subscription_status: "active",
  });
  const portalCreate = vi.fn().mockResolvedValue({ url: "https://billing.stripe.test/session/abc" });
  const customersCreate = vi.fn(); // should never be called
  const stripe = {
    customers: { create: customersCreate },
    billingPortal: { sessions: { create: portalCreate } },
  } as unknown as import("./types").StripeLike;

  const out = await createPortalSession(stripe, db, {
    sponsorId: "sp1",
    returnUrl: "https://app.test/sponsor/billing",
  });

  expect(out).toEqual({ url: "https://billing.stripe.test/session/abc" });
  expect(customersCreate).not.toHaveBeenCalled();
  const args = portalCreate.mock.calls[0][0] as Record<string, unknown>;
  expect(args.customer).toBe("cus_existing");
  expect(args.return_url).toBe("https://app.test/sponsor/billing");
});

test("listInvoices maps Stripe invoice fields to camelCase for a sponsor with a customer", async () => {
  const { db } = fakeDb({
    id: "sp1",
    name: "Acme",
    plan: "team",
    seats: 5,
    stripe_customer_id: "cus_existing",
    stripe_subscription_id: "sub_1",
    subscription_status: "active",
  });
  const invoicesList = vi.fn().mockResolvedValue({
    data: [
      {
        id: "in_2",
        status: "paid",
        amount_paid: 4900,
        hosted_invoice_url: "https://invoice.stripe.test/in_2",
        created: 1717200000,
      },
      {
        id: "in_1",
        status: "open",
        amount_paid: 0,
        hosted_invoice_url: null,
        created: 1714521600,
      },
    ],
  });
  const stripe = {
    invoices: { list: invoicesList },
  } as unknown as import("./types").StripeLike;

  const out = await listInvoices(stripe, db, "sp1");

  // Stripe is queried scoped to the sponsor's customer, bounded to a small page.
  const listArgs = invoicesList.mock.calls[0][0] as Record<string, unknown>;
  expect(listArgs.customer).toBe("cus_existing");
  expect(listArgs.limit).toBe(12);

  expect(out).toEqual([
    { id: "in_2", status: "paid", amountPaid: 4900, hostedUrl: "https://invoice.stripe.test/in_2", created: 1717200000 },
    { id: "in_1", status: "open", amountPaid: 0, hostedUrl: null, created: 1714521600 },
  ]);
});

test("listInvoices returns [] without calling Stripe when the sponsor has no customer", async () => {
  const { db } = fakeDb({
    id: "sp2",
    name: "NoCust",
    plan: "free",
    seats: 0,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    subscription_status: "inactive",
  });
  const invoicesList = vi.fn();
  const stripe = { invoices: { list: invoicesList } } as unknown as import("./types").StripeLike;

  const out = await listInvoices(stripe, db, "sp2");

  expect(out).toEqual([]);
  expect(invoicesList).not.toHaveBeenCalled();
});
