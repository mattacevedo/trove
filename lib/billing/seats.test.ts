import { expect, test, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StripeLike } from "@/lib/billing/types";
import { countActiveMembers, syncSubscriptionSeats } from "./seats";

// --- Fake Supabase: the shapes seats.ts uses ---
// (a) cohort_members head count: .select("*",{count,head}).eq().eq() -> awaited -> { count, error }
// (b) sponsors read:             .select("stripe_subscription_id").eq().maybeSingle() -> { data, error }
// (c) sponsors seats write:      .update({ seats }).eq("id", sponsorId) -> awaited -> { error }
//     (reconciliation is the SOLE writer of sponsors.seats — F12 — so the fake records seatWrites)
interface CountChain {
  select: (cols: string, opts?: unknown) => CountChain;
  eq: (col: string, val: unknown) => CountChain;
  then: (res: (v: { count: number | null; error: null }) => void) => void;
}
interface SponsorReadChain {
  select: (cols: string) => SponsorReadChain;
  eq: (col: string, val: unknown) => SponsorReadChain;
  maybeSingle: () => Promise<{ data: { stripe_subscription_id: string | null } | null; error: null }>;
}
interface SponsorUpdateChain {
  eq: (col: string, val: unknown) => Promise<{ error: null }>;
}

function fakeDb(opts: { activeCount?: number; subscriptionId?: string | null; sponsorId?: string }) {
  const eqCalls: Array<[string, unknown]> = [];
  const seatWrites: number[] = []; // each sponsors.update({ seats }) value, in order
  const knownSponsorId = opts.sponsorId ?? "sp_1";
  const countChain: CountChain = {
    select: () => countChain,
    eq: (col, val) => {
      eqCalls.push([col, val]);
      return countChain;
    },
    then: (res) => res({ count: opts.activeCount ?? 0, error: null }),
  };
  // sponsors read must HONOR .eq(col, val): a non-matching id returns null (the plan explicitly
  // hardened this after a review found a lenient fake masking a wrong-id wiring bug).
  function sponsorReadBuilder(): SponsorReadChain {
    let matchVal: unknown;
    const chain: SponsorReadChain = {
      select: () => chain,
      eq: (_col, val) => {
        matchVal = val;
        return chain;
      },
      maybeSingle: async () =>
        matchVal === knownSponsorId
          ? { data: { stripe_subscription_id: opts.subscriptionId ?? null }, error: null }
          : { data: null, error: null },
    };
    return chain;
  }
  // .from("sponsors") must serve BOTH the read (select→…→maybeSingle) and the seats write
  // (update→eq). We return an object exposing both entry points.
  const sponsorTable = {
    select: () => sponsorReadBuilder(),
    update: (patch: { seats: number }): SponsorUpdateChain => {
      seatWrites.push(patch.seats);
      return { eq: async () => ({ error: null }) };
    },
  };
  const from = vi.fn((table: string) =>
    table === "sponsors" ? sponsorTable : countChain
  );
  return { db: { from } as unknown as SupabaseClient, from, eqCalls, seatWrites };
}

// --- Fake StripeLike: only subscriptions.retrieve/update are exercised here ---
function fakeStripe(opts: { itemId?: string; existingQty?: number }) {
  const retrieve = vi.fn(async (id: string) => ({
    id,
    status: "active",
    items: {
      data: [{ id: opts.itemId ?? "si_123", quantity: opts.existingQty ?? 1 }],
    },
  }));
  const update = vi.fn(async (id: string, _args?: unknown) => ({ id }));
  const stripe = {
    subscriptions: { retrieve, update },
  } as unknown as StripeLike;
  return { stripe, retrieve, update };
}

test("countActiveMembers counts only status='active' rows for the sponsor", async () => {
  const { db, from, eqCalls } = fakeDb({ activeCount: 3 });
  const n = await countActiveMembers(db, "sp_1");
  expect(n).toBe(3);
  expect(from).toHaveBeenCalledWith("cohort_members");
  // filters on the sponsor and on the active status
  expect(eqCalls).toContainEqual(["sponsor_id", "sp_1"]);
  expect(eqCalls).toContainEqual(["status", "active"]);
});

test("countActiveMembers treats a null count as 0", async () => {
  const { db } = fakeDb({ activeCount: null as unknown as number });
  expect(await countActiveMembers(db, "sp_1")).toBe(0);
});

test("syncSubscriptionSeats no-ops in Stripe (skipped) when the sponsor has no subscription yet, but still writes seats", async () => {
  const { db, seatWrites } = fakeDb({ activeCount: 2, subscriptionId: null });
  const { stripe, retrieve, update } = fakeStripe({});
  const out = await syncSubscriptionSeats(stripe, db, "sp_1");
  expect(out).toEqual({ quantity: 2, skipped: true });
  // No subscription -> no Stripe traffic at all.
  expect(retrieve).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  // Reconciliation is still the sole writer of sponsors.seats — the count is persisted (F12).
  expect(seatWrites).toEqual([2]);
});

test("syncSubscriptionSeats updates the item to the active count with proration AND persists DB seats", async () => {
  // Stripe currently shows 3, active count is 5 -> they differ, so an update fires.
  const { db, seatWrites } = fakeDb({ activeCount: 5, subscriptionId: "sub_abc" });
  const { stripe, retrieve, update } = fakeStripe({ itemId: "si_777", existingQty: 3 });

  const out = await syncSubscriptionSeats(stripe, db, "sp_1");
  expect(out).toEqual({ quantity: 5, skipped: false });

  // Retrieves the sponsor's subscription by its stored id.
  expect(retrieve).toHaveBeenCalledWith("sub_abc");

  // Updates that subscription's single line item to the fresh active count, with proration.
  expect(update).toHaveBeenCalledTimes(1);
  const [subId, args] = update.mock.calls[0] as [
    string,
    { items: Array<{ id: string; quantity: number }>; proration_behavior: string }
  ];
  expect(subId).toBe("sub_abc");
  expect(args.items).toEqual([{ id: "si_777", quantity: 5 }]);
  expect(args.proration_behavior).toBe("create_prorations");

  // Single source of truth: DB seats == active count == the quantity pushed to Stripe (F12).
  expect(seatWrites).toEqual([5]);
  expect(args.items[0].quantity).toBe(5);
});

test("syncSubscriptionSeats sets quantity to 0 when there are no active members", async () => {
  // Stripe shows 1 (default existingQty), active count is 0 -> differ -> update fires.
  const { db, seatWrites } = fakeDb({ activeCount: 0, subscriptionId: "sub_zero" });
  const { stripe, update } = fakeStripe({ itemId: "si_1" });
  const out = await syncSubscriptionSeats(stripe, db, "sp_1");
  expect(out).toEqual({ quantity: 0, skipped: false });
  const [, args] = update.mock.calls[0] as [
    string,
    { items: Array<{ id: string; quantity: number }> }
  ];
  expect(args.items[0].quantity).toBe(0);
  expect(seatWrites).toEqual([0]);
});

test("syncSubscriptionSeats does NOT call subscriptions.update when Stripe already matches (echo-loop break, F11)", async () => {
  // Stripe already shows 4 and the active count is 4 -> no update should be emitted.
  const { db, seatWrites } = fakeDb({ activeCount: 4, subscriptionId: "sub_match" });
  const { stripe, retrieve, update } = fakeStripe({ itemId: "si_match", existingQty: 4 });

  const out = await syncSubscriptionSeats(stripe, db, "sp_1");
  expect(out).toEqual({ quantity: 4, skipped: true });
  expect(retrieve).toHaveBeenCalledWith("sub_match");
  expect(update).not.toHaveBeenCalled();
  // Seats are still reconciled in the DB (idempotent write of the same value).
  expect(seatWrites).toEqual([4]);

  // Re-running immediately yields NO second Stripe update either (idempotent / no fight loop).
  const again = await syncSubscriptionSeats(stripe, db, "sp_1");
  expect(again).toEqual({ quantity: 4, skipped: true });
  expect(update).not.toHaveBeenCalled();
});

test("syncSubscriptionSeats sponsors read honors .eq(id, val): a non-matching sponsor id resolves to null", async () => {
  // Regression guard for the hardening the plan calls out: a lenient fake that ignores the .eq
  // filter would mask a bug where the wrong sponsorId is threaded through. Here the fake only
  // knows about "sp_known"; calling with "sp_other" must see stripe_subscription_id as absent
  // (null), so syncSubscriptionSeats skips Stripe entirely rather than accidentally matching.
  const { db, seatWrites } = fakeDb({ activeCount: 1, subscriptionId: "sub_should_not_be_seen", sponsorId: "sp_known" });
  const { stripe, retrieve, update } = fakeStripe({});
  const out = await syncSubscriptionSeats(stripe, db, "sp_other");
  expect(out).toEqual({ quantity: 1, skipped: true });
  expect(retrieve).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect(seatWrites).toEqual([1]);
});
