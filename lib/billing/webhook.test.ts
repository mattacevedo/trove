import { expect, test, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// Mutable fake Stripe surface, defined via vi.hoisted so the (hoisted) vi.mock factory below can
// safely reference it. Task 12 needs subscriptions.retrieve for the live-truth read on
// customer.subscription.updated; Task 13 later drives subscriptions.update through the SAME fake.
// Default retrieve reports an ACTIVE subscription; individual tests reassign subRetrieve as needed.
const stripeFake = vi.hoisted(() => {
  const makeRetrieve = () =>
    vi.fn(async (id: string) => ({
      id,
      status: "active",
      items: { data: [{ id: "si_live", quantity: 1 }] },
    }));
  return {
    subRetrieve: makeRetrieve(),
    subUpdate: vi.fn(async (id: string) => ({ id })),
    makeRetrieve,
  };
});

vi.mock("@/lib/billing/stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing/stripe")>();
  return {
    ...actual, // keep the real planForPriceId / PLAN_BY_PRICE_ID
    createStripeClient: () => ({
      subscriptions: {
        retrieve: (id: string) => stripeFake.subRetrieve(id),
        update: (id: string, args: unknown) => stripeFake.subUpdate(id, args),
      },
    }),
  };
});

import { handleStripeEvent } from "./webhook";

// Convenience aliases so individual tests can reassign the fakes ergonomically.
let subRetrieve = stripeFake.subRetrieve;
let subUpdate = stripeFake.subUpdate;

beforeEach(() => {
  // Reset to the default active-subscription behavior before each test.
  stripeFake.subRetrieve = stripeFake.makeRetrieve();
  stripeFake.subUpdate = vi.fn(async (id: string) => ({ id }));
  subRetrieve = stripeFake.subRetrieve;
  subUpdate = stripeFake.subUpdate;
});

/**
 * A fake service-role Supabase client. Models:
 *  - stripe_events: insert(id) -> unique-violation (23505) if the id was already inserted.
 *  - sponsors: update(values).eq(col, val) recorded; select().eq().maybeSingle() returns a canned row.
 *  - cohort_members: head-count query -> { count } (needed once Task 13's reconcile runs inside the
 *    updated branch; harmless before then). `opts.activeCount` defaults to 0.
 * `opts.sponsorRow` is what the sponsors select resolves to (null => no sponsor for that customer).
 * The updated-branch tests below assert with `.some(...)` on `updates` rather than an exact length,
 * so they stay green AFTER Task 13 appends the seats-reconcile write to the same branch.
 */
function fakeDb(opts?: { sponsorRow?: Record<string, unknown> | null; activeCount?: number }) {
  const updates: Array<{ table: string; values: Record<string, unknown>; eqCol: string; eqVal: unknown }> = [];
  const seenEvents = new Set<string>();
  const sponsorRow = opts?.sponsorRow === undefined
    ? { id: "sp_1", stripe_subscription_id: null }
    : opts.sponsorRow;

  const client = {
    from(table: string) {
      if (table === "stripe_events") {
        return {
          insert(row: { id: string }) {
            if (seenEvents.has(row.id)) {
              return Promise.resolve({ error: { code: "23505", message: "duplicate key" } });
            }
            seenEvents.add(row.id);
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === "cohort_members") {
        const c: Record<string, unknown> = {};
        c.select = () => c;
        c.eq = () => c;
        c.then = (res: (v: { count: number; error: null }) => void) =>
          res({ count: opts?.activeCount ?? 0, error: null });
        return c;
      }
      // sponsors
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({ data: sponsorRow, error: null }),
              };
            },
          };
        },
        update(values: Record<string, unknown>) {
          return {
            eq(eqCol: string, eqVal: unknown) {
              updates.push({ table, values, eqCol, eqVal });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, updates };
}

test("customer.subscription.created writes status/id/plan keyed by stripe_customer_id (no seats)", async () => {
  const { client, updates } = fakeDb();
  const out = await handleStripeEvent(client, {
    id: "evt_created_1",
    type: "customer.subscription.created",
    data: {
      object: {
        id: "sub_123",
        customer: "cus_abc",
        status: "active",
        items: { data: [{ quantity: 5, price: { id: "price_x" } }] },
      },
    },
  });

  expect(out).toEqual({ handled: true });
  expect(updates).toHaveLength(1);
  expect(updates[0].table).toBe("sponsors");
  expect(updates[0].eqCol).toBe("stripe_customer_id");
  expect(updates[0].eqVal).toBe("cus_abc");
  expect(updates[0].values).toMatchObject({
    subscription_status: "active",
    stripe_subscription_id: "sub_123",
    plan: "free", // price_x is not in PLAN_BY_PRICE_ID (env unset) -> 'free'
  });
  // Seats are NEVER written here — reconciliation is the sole writer (F12).
  expect(updates[0].values).not.toHaveProperty("seats");
});

test("customer.subscription.updated writes the LIVE status, not the (stale) event payload", async () => {
  // Event payload SAYS active, but the live subscription is past_due — live must win.
  // Reassign on stripeFake (the object the mock factory reads), not just the local alias.
  stripeFake.subRetrieve = vi.fn(async (id: string) => ({
    id,
    status: "past_due",
    items: { data: [{ id: "si_live", quantity: 3 }] },
  }));
  subRetrieve = stripeFake.subRetrieve;
  const { client, updates } = fakeDb({ sponsorRow: { id: "sp_1", stripe_subscription_id: "sub_123" } });
  const out = await handleStripeEvent(client, {
    id: "evt_updated_1",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_123",
        customer: "cus_abc",
        status: "active", // stale
        items: { data: [{ price: { id: "price_x" } }] },
      },
    },
  });
  expect(out).toEqual({ handled: true });
  expect(subRetrieve).toHaveBeenCalledWith("sub_123");
  // The status write (keyed by customer) uses the LIVE status and carries no seats. Asserted with
  // .some() so this stays green after Task 13 appends a seats-reconcile write to the same branch.
  const statusWrite = updates.find((u) => u.eqCol === "stripe_customer_id");
  expect(statusWrite).toBeDefined();
  expect(statusWrite!.values).toMatchObject({
    subscription_status: "past_due", // from the live object
    stripe_subscription_id: "sub_123",
  });
  expect(statusWrite!.values).not.toHaveProperty("seats");
});

test("customer.subscription.deleted marks the sponsor canceled and clears the subscription id", async () => {
  const { client, updates } = fakeDb();
  const out = await handleStripeEvent(client, {
    id: "evt_deleted_1",
    type: "customer.subscription.deleted",
    data: { object: { id: "sub_123", customer: "cus_abc", status: "canceled", items: { data: [] } } },
  });
  expect(out).toEqual({ handled: true });
  expect(updates[0].values).toMatchObject({
    subscription_status: "canceled",
    stripe_subscription_id: null,
  });
  expect(updates[0].eqVal).toBe("cus_abc");
});

test("a stale customer.subscription.updated after deletion does NOT re-activate (terminal)", async () => {
  // The live subscription is canceled; a late 'updated' whose payload says active must not resurrect.
  stripeFake.subRetrieve = vi.fn(async (id: string) => ({ id, status: "canceled", items: { data: [] } }));
  subRetrieve = stripeFake.subRetrieve;
  const { client, updates } = fakeDb({ sponsorRow: { id: "sp_1", stripe_subscription_id: "sub_123" } });
  const out = await handleStripeEvent(client, {
    id: "evt_updated_stale",
    type: "customer.subscription.updated",
    data: {
      object: { id: "sub_123", customer: "cus_abc", status: "active", items: { data: [] } },
    },
  });
  expect(out).toEqual({ handled: true });
  expect(updates).toHaveLength(1);
  expect(updates[0].values).toMatchObject({
    subscription_status: "canceled",
    stripe_subscription_id: null,
  });
});

test("a duplicate event id is applied only once (idempotency via stripe_events)", async () => {
  const { client, updates } = fakeDb();
  const event = {
    id: "evt_dup",
    type: "customer.subscription.created",
    data: {
      object: {
        id: "sub_123",
        customer: "cus_abc",
        status: "active",
        items: { data: [{ price: { id: "price_x" } }] },
      },
    },
  };
  const first = await handleStripeEvent(client, event);
  const second = await handleStripeEvent(client, event); // duplicate delivery
  expect(first).toEqual({ handled: true });
  expect(second).toEqual({ handled: true });
  // Side effect applied exactly once despite two deliveries.
  expect(updates).toHaveLength(1);
});

test("invoice.paid/payment_failed act only when billing_reason + subscription correlate", async () => {
  // (a) correlated cycle invoice for the sponsor's current sub -> active.
  const paid = fakeDb({ sponsorRow: { id: "sp_1", stripe_subscription_id: "sub_123" } });
  await handleStripeEvent(paid.client, {
    id: "evt_inv_paid",
    type: "invoice.paid",
    data: { object: { customer: "cus_abc", subscription: "sub_123", billing_reason: "subscription_cycle" } },
  });
  expect(paid.updates[0].values).toMatchObject({ subscription_status: "active" });

  // (b) correlated failure -> past_due.
  const failed = fakeDb({ sponsorRow: { id: "sp_1", stripe_subscription_id: "sub_123" } });
  await handleStripeEvent(failed.client, {
    id: "evt_inv_failed",
    type: "invoice.payment_failed",
    data: { object: { customer: "cus_abc", subscription: "sub_123", billing_reason: "subscription_cycle" } },
  });
  expect(failed.updates[0].values).toMatchObject({ subscription_status: "past_due" });

  // (c) a non-subscription billing_reason is ignored (no write).
  const oneOff = fakeDb({ sponsorRow: { id: "sp_1", stripe_subscription_id: "sub_123" } });
  const outOneOff = await handleStripeEvent(oneOff.client, {
    id: "evt_inv_manual",
    type: "invoice.paid",
    data: { object: { customer: "cus_abc", subscription: "sub_123", billing_reason: "manual" } },
  });
  expect(outOneOff).toEqual({ handled: false });
  expect(oneOff.updates).toHaveLength(0);

  // (d) an invoice for a DIFFERENT subscription than the sponsor's current one is ignored.
  const mismatch = fakeDb({ sponsorRow: { id: "sp_1", stripe_subscription_id: "sub_123" } });
  const outMismatch = await handleStripeEvent(mismatch.client, {
    id: "evt_inv_other",
    type: "invoice.paid",
    data: { object: { customer: "cus_abc", subscription: "sub_OTHER", billing_reason: "subscription_cycle" } },
  });
  expect(outMismatch).toEqual({ handled: false });
  expect(mismatch.updates).toHaveLength(0);
});

test("an uninteresting event type is ignored (no DB write, handled:false)", async () => {
  const { client, updates } = fakeDb();
  const out = await handleStripeEvent(client, {
    id: "evt_charge",
    type: "charge.refunded",
    data: { object: { customer: "cus_abc" } },
  });
  expect(out).toEqual({ handled: false });
  expect(updates).toHaveLength(0);
});

test("an updated event missing a customer id is ignored (no write, handled:false)", async () => {
  const { client, updates } = fakeDb();
  const out = await handleStripeEvent(client, {
    id: "evt_nocust",
    type: "customer.subscription.updated",
    data: { object: { id: "sub_123", status: "active", items: { data: [] } } },
  });
  expect(out).toEqual({ handled: false });
  expect(updates).toHaveLength(0);
});

test("an updated event whose customer maps to no sponsor is ignored", async () => {
  const { client, updates } = fakeDb({ sponsorRow: null });
  const out = await handleStripeEvent(client, {
    id: "evt_nosponsor",
    type: "customer.subscription.updated",
    data: { object: { id: "sub_123", customer: "cus_unknown", status: "active", items: { data: [] } } },
  });
  expect(out).toEqual({ handled: false });
  expect(updates).toHaveLength(0);
});

test("throws when the sponsors update returns a PostgREST error", async () => {
  const client = {
    from(table: string) {
      if (table === "stripe_events") return { insert: () => Promise.resolve({ error: null }) };
      return {
        select() {
          return { eq() { return { maybeSingle: async () => ({ data: { id: "sp_1", stripe_subscription_id: "sub_123" }, error: null }) }; } };
        },
        update() {
          return { eq: () => Promise.resolve({ error: { message: "boom" } }) };
        },
      };
    },
  } as unknown as SupabaseClient;
  await expect(
    handleStripeEvent(client, {
      id: "evt_err",
      type: "invoice.paid",
      data: { object: { customer: "cus_abc", subscription: "sub_123", billing_reason: "subscription_cycle" } },
    })
  ).rejects.toThrow(/boom/);
});
