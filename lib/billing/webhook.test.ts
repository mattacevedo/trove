import { expect, test, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// The exact return shape of StripeLike.subscriptions.retrieve (mirrors lib/billing/types.ts).
// `makeRetrieve`'s fn is explicitly annotated to return THIS shape (with optional quantity/price per
// item) so every reassignment of subRetrieve across this file — regardless of which optional fields a
// given test includes — type-checks against the same signature instead of vi.hoisted inferring a
// narrower one from the first literal.
type RetrieveResult = {
  id: string;
  status: string;
  items: { data: Array<{ id: string; quantity?: number; price?: { id: string } }> };
};

// Mutable fake Stripe surface, defined via vi.hoisted so the (hoisted) vi.mock factory below can
// safely reference it. Task 12 needs subscriptions.retrieve for the live-truth read on
// customer.subscription.updated; Task 13 later drives subscriptions.update through the SAME fake.
// Default retrieve reports an ACTIVE subscription; individual tests reassign subRetrieve as needed.
const stripeFake = vi.hoisted(() => {
  const makeRetrieve = () =>
    vi.fn(async (id: string): Promise<RetrieveResult> => ({
      id,
      status: "active",
      items: { data: [{ id: "si_live", quantity: 1, price: { id: "price_x" } }] },
    }));
  return {
    subRetrieve: makeRetrieve(),
    // Typed with the same (id, args) arity as StripeLike.subscriptions.update (lib/billing/types.ts)
    // so the mock factory below can forward both arguments; Task 13 asserts on the `args` payload.
    subUpdate: vi.fn(async (id: string, args: unknown) => ({ id, args })),
    // Records every priceId passed into planForPriceId, so F2 tests can assert webhook.ts derives
    // plan from the LIVE object's price id rather than the event payload's, WITHOUT needing
    // STRIPE_PRICE_ID/PLAN_BY_PRICE_ID (fixed at module-eval time, can't be changed per-test).
    planForPriceIdCalls: [] as Array<string | null | undefined>,
    makeRetrieve,
  };
});

vi.mock("@/lib/billing/stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing/stripe")>();
  return {
    ...actual, // keep the real PLAN_BY_PRICE_ID
    createStripeClient: () => ({
      subscriptions: {
        retrieve: (id: string) => stripeFake.subRetrieve(id),
        update: (id: string, args: unknown) => stripeFake.subUpdate(id, args),
      },
    }),
    // Spy wrapper: records the priceId argument, then delegates to the REAL implementation so
    // behavior (including the "free" fallback) is unchanged.
    planForPriceId: (priceId: string | null | undefined) => {
      stripeFake.planForPriceIdCalls.push(priceId);
      return actual.planForPriceId(priceId);
    },
  };
});

import { handleStripeEvent } from "./webhook";

// Convenience aliases so individual tests can reassign the fakes ergonomically.
let subRetrieve = stripeFake.subRetrieve;
let subUpdate = stripeFake.subUpdate;
void subUpdate; // referenced by Task 13's reconciliation tests appended to this file; unused here.

beforeEach(() => {
  // Reset to the default active-subscription behavior before each test.
  stripeFake.subRetrieve = stripeFake.makeRetrieve();
  stripeFake.subUpdate = vi.fn(async (id: string, args: unknown) => ({ id, args }));
  subRetrieve = stripeFake.subRetrieve;
  subUpdate = stripeFake.subUpdate;
  stripeFake.planForPriceIdCalls = [];
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

test("F3: customer.subscription.created for an unknown customer is handled:false with no write (consistent with updated/invoice)", async () => {
  const { client, updates } = fakeDb({ sponsorRow: null });
  const out = await handleStripeEvent(client, {
    id: "evt_created_unknown_customer",
    type: "customer.subscription.created",
    data: {
      object: {
        id: "sub_999",
        customer: "cus_unknown",
        status: "active",
        items: { data: [{ price: { id: "price_x" } }] },
      },
    },
  });
  expect(out).toEqual({ handled: false });
  expect(updates).toHaveLength(0);
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

test("F2: customer.subscription.updated derives `plan` from the LIVE item's price, not the event payload's", async () => {
  // Live retrieve reports one price; the event payload (stale) claims a DIFFERENT one. Assert
  // planForPriceId is invoked with the LIVE price id, never the event's — this fails against the old
  // implementation (which called planForPriceId(firstPriceId(object)), i.e. the event payload).
  stripeFake.subRetrieve = vi.fn(async (id: string) => ({
    id,
    status: "active",
    items: { data: [{ id: "si_live", quantity: 3, price: { id: "price_live_team" } }] },
  }));
  subRetrieve = stripeFake.subRetrieve;
  const { client } = fakeDb({ sponsorRow: { id: "sp_1", stripe_subscription_id: "sub_123" } });
  const out = await handleStripeEvent(client, {
    id: "evt_updated_plan_live",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_123",
        customer: "cus_abc",
        status: "active",
        items: { data: [{ price: { id: "price_event_stale" } }] }, // stale/mismatched payload price
      },
    },
  });
  expect(out).toEqual({ handled: true });
  expect(stripeFake.planForPriceIdCalls).toContain("price_live_team");
  expect(stripeFake.planForPriceIdCalls).not.toContain("price_event_stale");
});

test("F2: customer.subscription.updated falls back to the event payload's price when the live item lacks one", async () => {
  // Live item has NO price (defensive case — StripeLike types price as optional). The fallback
  // still reads from the event payload rather than silently mapping to 'free'.
  stripeFake.subRetrieve = vi.fn(async (id: string) => ({
    id,
    status: "active",
    items: { data: [{ id: "si_live", quantity: 3 }] },
  }));
  subRetrieve = stripeFake.subRetrieve;
  const { client } = fakeDb({ sponsorRow: { id: "sp_1", stripe_subscription_id: "sub_123" } });
  const out = await handleStripeEvent(client, {
    id: "evt_updated_plan_fallback",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_123",
        customer: "cus_abc",
        status: "active",
        items: { data: [{ price: { id: "price_live_team" } }] },
      },
    },
  });
  expect(out).toEqual({ handled: true });
  expect(stripeFake.planForPriceIdCalls).toContain("price_live_team"); // fell back to the event's price id
});

test("CAUSE A: customer.subscription.updated (live-active path) reconciles seats via syncSubscriptionSeats", async () => {
  // The live subscription's item quantity (1) does not match the sponsor's active cohort_members
  // count (3) -> the webhook's post-write reconcile must recompute and push the new quantity to
  // Stripe (via subscriptions.update) AND persist sponsors.seats, exactly like syncSubscriptionSeats
  // would if called directly with these inputs.
  stripeFake.subRetrieve = vi.fn(async (id: string) => ({
    id,
    status: "active",
    items: { data: [{ id: "si_live", quantity: 1, price: { id: "price_x" } }] },
  }));
  subRetrieve = stripeFake.subRetrieve;
  const { client, updates } = fakeDb({
    sponsorRow: { id: "sp_1", stripe_subscription_id: "sub_123" },
    activeCount: 3,
  });
  const out = await handleStripeEvent(client, {
    id: "evt_updated_seats_reconcile",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_123",
        customer: "cus_abc",
        status: "active",
        items: { data: [{ price: { id: "price_x" } }] },
      },
    },
  });
  expect(out).toEqual({ handled: true });

  // subscriptions.update was called with the recomputed quantity (3), keyed to the live item id.
  expect(subUpdate).toHaveBeenCalledWith("sub_123", {
    items: [{ id: "si_live", quantity: 3 }],
    proration_behavior: "create_prorations",
  });

  // sponsors.seats was written (the seats-reconcile update), in addition to the status/plan write.
  const seatsWrite = updates.find(
    (u) => u.table === "sponsors" && Object.prototype.hasOwnProperty.call(u.values, "seats")
  );
  expect(seatsWrite).toBeDefined();
  expect(seatsWrite!.values).toMatchObject({ seats: 3 });
});

test("CAUSE A regression: the STALE-guard path (mismatched sub id) does NOT reconcile seats or touch the sponsor row at all", async () => {
  const { client, updates } = fakeDb({
    sponsorRow: { id: "sp_1", stripe_subscription_id: "sub_CURRENT" },
    activeCount: 5,
  });
  const out = await handleStripeEvent(client, {
    id: "evt_updated_stale_guard_no_seats",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_OLD", // does not match sponsor.stripe_subscription_id ("sub_CURRENT")
        customer: "cus_abc",
        status: "active",
        items: { data: [{ price: { id: "price_x" } }] },
      },
    },
  });
  expect(out).toEqual({ handled: false });
  expect(updates).toHaveLength(0);
  expect(subRetrieve).not.toHaveBeenCalled();
  expect(subUpdate).not.toHaveBeenCalled();
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

/**
 * A stateful fake db (unlike `fakeDb`, whose sponsors row is a static snapshot): the sponsors
 * `select` reflects whatever the LAST `update` wrote, so a sequence of handleStripeEvent calls can
 * be driven against it and each subsequent read sees prior writes — needed to reproduce the
 * resurrection-ordering hole (deleted -> stale updated for the SAME old sub id). Also supports the
 * cohort_members head-count query (CAUSE A: syncSubscriptionSeats runs inside the live-active
 * updated-branch write path now), defaulting to 0 active members — harmless for tests that don't
 * care about the seats reconcile's exact quantity.
 */
function statefulFakeDb(initialRow: Record<string, unknown>, opts?: { activeCount?: number }) {
  const updates: Array<{ table: string; values: Record<string, unknown>; eqCol: string; eqVal: unknown }> = [];
  const seenEvents = new Set<string>();
  let sponsorRow: Record<string, unknown> | null = { ...initialRow };

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
              if (sponsorRow) sponsorRow = { ...sponsorRow, ...values };
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, updates, getSponsorRow: () => sponsorRow };
}

test("F1: a stale 'updated' for the OLD sub id after deletion does NOT resurrect, even when live retrieve reports active", async () => {
  // Reproduces the resurrection-ordering hole: .deleted sets status=canceled + clears the sub id;
  // a LATE .updated for that SAME old sub id arrives whose live retrieve (implausibly, but this is
  // exactly the adversarial case) reports an ACTIVE-looking object. Nothing local should let this
  // re-write status/plan/sub id, because the sponsor's CURRENT stripe_subscription_id no longer
  // matches (it's null after deletion) — the event is stale by construction.
  const { client, updates, getSponsorRow } = statefulFakeDb({
    id: "sp_1",
    stripe_subscription_id: "sub_OLD",
  });

  const deletedOut = await handleStripeEvent(client, {
    id: "evt_del_1",
    type: "customer.subscription.deleted",
    data: { object: { id: "sub_OLD", customer: "cus_abc", status: "canceled", items: { data: [] } } },
  });
  expect(deletedOut).toEqual({ handled: true });
  expect(getSponsorRow()).toMatchObject({ subscription_status: "canceled", stripe_subscription_id: null });

  // The live retrieve for sub_OLD (implausibly) reports active — Stripe would never really do this
  // for a subscription that was just deleted, but the fix must not DEPEND on that never happening.
  stripeFake.subRetrieve = vi.fn(async (id: string) => ({
    id,
    status: "active",
    items: { data: [{ id: "si_live", price: { id: "price_x" } }] },
  }));

  const updatesBefore = updates.length;
  const staleUpdatedOut = await handleStripeEvent(client, {
    id: "evt_upd_stale_after_delete",
    type: "customer.subscription.updated",
    data: {
      object: { id: "sub_OLD", customer: "cus_abc", status: "active", items: { data: [{ price: { id: "price_x" } }] } },
    },
  });

  // No NEW write happened, and the row is still exactly as .deleted left it.
  expect(updates.length).toBe(updatesBefore);
  expect(staleUpdatedOut).toEqual({ handled: false });
  expect(getSponsorRow()).toMatchObject({ subscription_status: "canceled", stripe_subscription_id: null });
});

test("F1 control: a NEW sub id after a prior deletion DOES activate (no false lockout)", async () => {
  // A genuinely new subscription (fresh checkout) must still activate normally even though the
  // sponsor's row was previously canceled by an earlier deletion.
  const { client, updates, getSponsorRow } = statefulFakeDb({
    id: "sp_1",
    stripe_subscription_id: "sub_OLD",
  });

  await handleStripeEvent(client, {
    id: "evt_del_2",
    type: "customer.subscription.deleted",
    data: { object: { id: "sub_OLD", customer: "cus_abc", status: "canceled", items: { data: [] } } },
  });
  expect(getSponsorRow()).toMatchObject({ stripe_subscription_id: null });

  // New checkout produces a NEW subscription id; created branch activates it.
  const createdOut = await handleStripeEvent(client, {
    id: "evt_created_after_delete",
    type: "customer.subscription.created",
    data: {
      object: {
        id: "sub_NEW",
        customer: "cus_abc",
        status: "active",
        items: { data: [{ price: { id: "price_x" } }] },
      },
    },
  });
  expect(createdOut).toEqual({ handled: true });
  expect(getSponsorRow()).toMatchObject({
    subscription_status: "active",
    stripe_subscription_id: "sub_NEW",
  });

  // A subsequent legitimate .updated for the NEW sub id (live retrieve active) also applies.
  stripeFake.subRetrieve = vi.fn(async (id: string) => ({
    id,
    status: "active",
    items: { data: [{ id: "si_live", price: { id: "price_x" } }] },
  }));
  const updatedOut = await handleStripeEvent(client, {
    id: "evt_updated_new_sub",
    type: "customer.subscription.updated",
    data: {
      object: { id: "sub_NEW", customer: "cus_abc", status: "active", items: { data: [{ price: { id: "price_x" } }] } },
    },
  });
  expect(updatedOut).toEqual({ handled: true });
  expect(updates.some((u) => u.values.stripe_subscription_id === "sub_NEW" && u.values.subscription_status === "active")).toBe(true);
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
      if (table === "stripe_events") {
        return {
          insert: () => Promise.resolve({ error: null }),
          delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
        };
      }
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

/**
 * CAUSE C: recordEvent inserts event.id into stripe_events BEFORE any side effects run. If dispatch
 * throws AFTER that insert succeeds, Stripe's retry would re-deliver the same event, recordEvent
 * would hit 23505 (already seen), return handled:true, and the side effects would be PERMANENTLY
 * lost. The fix: on any thrown dispatch error, best-effort DELETE the stripe_events row for that
 * event id, then re-throw — so the caller still 500s (Stripe retries) and the retry is processed as
 * fresh (the ledger row is gone).
 *
 * This fake models a mutable stripe_events ledger (insert/delete truly mutate a Set, unlike the other
 * fakes in this file) plus a `sponsors` table whose update() can be toggled to fail once via
 * `failNextSponsorsUpdate`, so the SAME event id can be redelivered and this time succeed.
 */
function causeCFakeDb() {
  const events = new Set<string>();
  const deletedEventIds: string[] = [];
  let failNextSponsorsUpdate = false;
  const sponsorsUpdates: Array<Record<string, unknown>> = [];

  const client = {
    from(table: string) {
      if (table === "stripe_events") {
        return {
          insert(row: { id: string }) {
            if (events.has(row.id)) {
              return Promise.resolve({ error: { code: "23505", message: "duplicate key" } });
            }
            events.add(row.id);
            return Promise.resolve({ error: null });
          },
          delete() {
            return {
              eq(_col: string, val: string) {
                events.delete(val);
                deletedEventIds.push(val);
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      }
      if (table === "cohort_members") {
        const c: Record<string, unknown> = {};
        c.select = () => c;
        c.eq = () => c;
        c.then = (res: (v: { count: number; error: null }) => void) => res({ count: 0, error: null });
        return c;
      }
      // sponsors
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({
                  data: { id: "sp_1", stripe_subscription_id: "sub_123" },
                  error: null,
                }),
              };
            },
          };
        },
        update(values: Record<string, unknown>) {
          return {
            eq() {
              if (failNextSponsorsUpdate) {
                failNextSponsorsUpdate = false;
                return Promise.resolve({ error: { message: "simulated live DB failure" } });
              }
              sponsorsUpdates.push(values);
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  return {
    client,
    deletedEventIds,
    sponsorsUpdates,
    setFailNextSponsorsUpdate: (v: boolean) => {
      failNextSponsorsUpdate = v;
    },
    hasEvent: (id: string) => events.has(id),
  };
}

test("CAUSE C: a thrown error mid-dispatch deletes the stripe_events row so a retry is processed fresh", async () => {
  const db = causeCFakeDb();
  db.setFailNextSponsorsUpdate(true);

  const event = {
    id: "evt_partial_failure",
    type: "customer.subscription.deleted",
    data: { object: { id: "sub_123", customer: "cus_abc", status: "canceled", items: { data: [] } } },
  };

  // First delivery: recordEvent's insert succeeds, then the sponsors update throws.
  await expect(handleStripeEvent(db.client, event)).rejects.toThrow(/simulated live DB failure/);

  // The ledger row was removed (best-effort cleanup) so the event is no longer "seen".
  expect(db.hasEvent("evt_partial_failure")).toBe(false);
  expect(db.deletedEventIds).toContain("evt_partial_failure");
  expect(db.sponsorsUpdates).toHaveLength(0); // the failed write never landed

  // Second delivery of the SAME event (Stripe's retry): recordEvent's insert succeeds again (no
  // 23505, since the row was deleted), and this time the write succeeds -> side effects applied.
  const retryOut = await handleStripeEvent(db.client, event);
  expect(retryOut).toEqual({ handled: true });
  expect(db.sponsorsUpdates).toHaveLength(1);
  expect(db.sponsorsUpdates[0]).toMatchObject({
    subscription_status: "canceled",
    stripe_subscription_id: null,
  });
});

test("CAUSE C: a delete failure during cleanup is swallowed and the ORIGINAL error still propagates", async () => {
  const events = new Set<string>(["evt_delete_fails"]);
  const client = {
    from(table: string) {
      if (table === "stripe_events") {
        return {
          insert(row: { id: string }) {
            if (events.has(row.id)) {
              return Promise.resolve({ error: { code: "23505", message: "duplicate key" } });
            }
            events.add(row.id);
            return Promise.resolve({ error: null });
          },
          delete() {
            return {
              eq() {
                // The cleanup delete itself fails — must be swallowed, not surfaced.
                return Promise.resolve({ error: { message: "delete boom" } });
              },
            };
          },
        };
      }
      // sponsors: update throws to trigger the catch/cleanup path.
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({
                  data: { id: "sp_1", stripe_subscription_id: "sub_123" },
                  error: null,
                }),
              };
            },
          };
        },
        update() {
          return { eq: () => Promise.resolve({ error: { message: "original failure" } }) };
        },
      };
    },
  } as unknown as SupabaseClient;

  // Reset so recordEvent's insert succeeds fresh for this test's event id.
  events.delete("evt_delete_fails");

  await expect(
    handleStripeEvent(client, {
      id: "evt_delete_fails",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_123", customer: "cus_abc", status: "canceled", items: { data: [] } } },
    })
  ).rejects.toThrow(/original failure/); // NOT "delete boom" — the original error wins
});
