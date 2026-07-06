import { expect, test, vi } from "vitest";
import { NextRequest } from "next/server";
import { handlePost } from "./route";
import type { StripeLike } from "@/lib/billing/types";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Build a NextRequest carrying a raw JSON body and an optional stripe-signature header. */
function makeRequest(body: string, sig?: string): NextRequest {
  return new NextRequest("https://trove.test/api/stripe/webhook", {
    method: "POST",
    headers: sig ? { "stripe-signature": sig } : {},
    body,
  });
}

/** A fake StripeLike whose only exercised method is webhooks.constructEvent. */
function fakeStripe(constructEvent: StripeLike["webhooks"]["constructEvent"]): StripeLike {
  return {
    customers: { create: vi.fn() },
    checkout: { sessions: { create: vi.fn() } },
    billingPortal: { sessions: { create: vi.fn() } },
    subscriptions: { retrieve: vi.fn(), update: vi.fn() },
    invoices: { list: vi.fn() },
    webhooks: { constructEvent },
  } as unknown as StripeLike;
}

/**
 * A fake service-role db that records sponsors updates and models the stripe_events dedup insert
 * (same shapes handleStripeEvent uses). The good-sig test drives a customer.subscription.created
 * event, which inserts the event id then updates sponsors — so the fake supports both `insert` and
 * `update`. The injected fake StripeLike (fakeStripe) is what handleStripeEvent's created branch
 * needs — created writes status/id/plan directly without a live retrieve.
 */
function fakeDb() {
  const updates: Array<{ table: string; values: Record<string, unknown>; eqVal: unknown }> = [];
  const seen = new Set<string>();
  const client = {
    from(table: string) {
      if (table === "stripe_events") {
        return {
          insert(row: { id: string }) {
            if (seen.has(row.id)) return Promise.resolve({ error: { code: "23505", message: "dup" } });
            seen.add(row.id);
            return Promise.resolve({ error: null });
          },
        };
      }
      return {
        select() {
          return { eq() { return { maybeSingle: async () => ({ data: { id: "sp_1", stripe_subscription_id: null }, error: null }) }; } };
        },
        update(values: Record<string, unknown>) {
          return {
            eq(_col: string, eqVal: unknown) {
              updates.push({ table, values, eqVal });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, updates };
}

test("returns 200 and dispatches when the signature verifies", async () => {
  const rawBody = JSON.stringify({ any: "bytes" });
  // A subscription.created event writes status/id/plan directly (no live retrieve needed), so the
  // route's dispatch produces a single sponsors write we can assert.
  const constructEvent = vi.fn().mockReturnValue({
    id: "evt_route_1",
    created: 1,
    type: "customer.subscription.created",
    data: {
      object: {
        id: "sub_123",
        customer: "cus_abc",
        status: "active",
        items: { data: [{ price: { id: "price_x" } }] },
      },
    },
  });
  const stripe = fakeStripe(constructEvent);
  const db = fakeDb();

  const res = await handlePost(makeRequest(rawBody, "t=1,v1=goodsig"), {
    stripe,
    db: db.client,
    webhookSecret: "whsec_test",
  });

  expect(res.status).toBe(200);
  // constructEvent got the EXACT raw bytes + the header + the injected secret.
  expect(constructEvent).toHaveBeenCalledWith(rawBody, "t=1,v1=goodsig", "whsec_test");
  // The event was dispatched and produced a sponsors write.
  expect(db.updates).toHaveLength(1);
  expect(db.updates[0].table).toBe("sponsors");
  expect(db.updates[0].values).toMatchObject({ subscription_status: "active" });
  await expect(res.json()).resolves.toEqual({ received: true });
});

test("returns 400 when constructEvent throws (bad signature) — no DB write", async () => {
  const constructEvent = vi.fn().mockImplementation(() => {
    throw new Error("No signatures found matching the expected signature for payload");
  });
  const db = fakeDb();

  const res = await handlePost(makeRequest("{}", "t=1,v1=badsig"), {
    stripe: fakeStripe(constructEvent),
    db: db.client,
    webhookSecret: "whsec_test",
  });

  expect(res.status).toBe(400);
  expect(db.updates).toHaveLength(0);
});

test("returns 400 when the stripe-signature header is missing (constructEvent never called)", async () => {
  const constructEvent = vi.fn();
  const db = fakeDb();

  const res = await handlePost(makeRequest("{}"), {
    stripe: fakeStripe(constructEvent),
    db: db.client,
    webhookSecret: "whsec_test",
  });

  expect(res.status).toBe(400);
  expect(constructEvent).not.toHaveBeenCalled();
  expect(db.updates).toHaveLength(0);
});

test("returns 200 with handled:false for an uninteresting but validly-signed event (no write)", async () => {
  const constructEvent = vi.fn().mockReturnValue({
    id: "evt_route_charge",
    created: 1,
    type: "charge.refunded",
    data: { object: { customer: "cus_abc" } },
  });
  const db = fakeDb();

  const res = await handlePost(makeRequest("{}", "sig"), {
    stripe: fakeStripe(constructEvent),
    db: db.client,
    webhookSecret: "whsec_test",
  });

  expect(res.status).toBe(200);
  expect(db.updates).toHaveLength(0);
});

test("F4: a handleStripeEvent throw is mapped to a 500 response (preserves Stripe retry semantics)", async () => {
  // A valid, well-signed event whose dispatch throws (e.g. a DB error inside handleStripeEvent) must
  // surface as a 500 so Stripe retries the delivery, rather than escaping as an unhandled exception.
  const constructEvent = vi.fn().mockReturnValue({
    id: "evt_route_throws",
    created: 1,
    type: "customer.subscription.created",
    data: {
      object: {
        id: "sub_123",
        customer: "cus_abc",
        status: "active",
        items: { data: [{ price: { id: "price_x" } }] },
      },
    },
  });
  const stripe = fakeStripe(constructEvent);
  // A db whose sponsors update throws inside handleStripeEvent's created branch.
  const throwingDb = {
    from(table: string) {
      if (table === "stripe_events") {
        return { insert: () => Promise.resolve({ error: null }) };
      }
      return {
        select() {
          return { eq() { return { maybeSingle: async () => ({ data: { id: "sp_1", stripe_subscription_id: null }, error: null }) }; } };
        },
        update() {
          return { eq: () => Promise.resolve({ error: { message: "connection reset" } }) };
        },
      };
    },
  } as unknown as SupabaseClient;

  const res = await handlePost(makeRequest("{}", "t=1,v1=goodsig"), {
    stripe,
    db: throwingDb,
    webhookSecret: "whsec_test",
  });

  expect(res.status).toBe(500);
});
