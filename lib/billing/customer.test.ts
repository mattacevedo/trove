import { expect, test, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StripeLike } from "./types";
import { ensureStripeCustomer } from "./customer";

function fakeStripe(overrides?: Partial<StripeLike>): StripeLike {
  return {
    customers: { create: vi.fn().mockResolvedValue({ id: "cus_new" }) },
    checkout: { sessions: { create: vi.fn() } },
    billingPortal: { sessions: { create: vi.fn() } },
    subscriptions: { retrieve: vi.fn(), update: vi.fn() },
    invoices: { list: vi.fn() },
    webhooks: { constructEvent: vi.fn() },
    ...overrides,
  } as unknown as StripeLike;
}

// Minimal Supabase fake: one row of `sponsors` state, mutated by update().
//
// CAUSE J: the persist is now conditional — .update({stripe_customer_id}).eq("id", sponsorId)
//   .is("stripe_customer_id", null).select() — so a concurrent writer who already set the column
// first causes THIS call's update to affect zero rows. `opts.loseRace` simulates that: the update's
// WHERE clause (id match AND stripe_customer_id IS NULL) is evaluated against `state` exactly like
// Postgres would, so if some other actor already wrote a value before this update runs, it naturally
// resolves to zero affected rows without needing a separate flag.
function fakeDb(
  row: { name: string; stripe_customer_id: string | null },
  opts?: { concurrentWriterId?: string }
) {
  const state = { ...row };
  const update = vi.fn((patch: Record<string, unknown>) => {
    // A concurrent writer "wins" the race the instant this update() call is made, simulating another
    // process's UPDATE committing between our SELECT and our UPDATE.
    if (opts?.concurrentWriterId && state.stripe_customer_id === null) {
      state.stripe_customer_id = opts.concurrentWriterId;
    }
    const builder = {
      eq: vi.fn(() => builder),
      is(_col: string, _val: null) {
        // Only apply OUR patch if the column is STILL null at the moment the conditional WHERE
        // would run (i.e. no concurrent writer beat us to it).
        const affected = state.stripe_customer_id === null;
        if (affected) Object.assign(state, patch);
        return {
          select: () => ({
            then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
              resolve({ data: affected ? [{ ...state }] : [], error: null }),
          }),
        };
      },
    };
    return builder;
  });
  const from = vi.fn((table: string) => {
    expect(table).toBe("sponsors");
    return {
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn().mockResolvedValue({
            data: { name: state.name, stripe_customer_id: state.stripe_customer_id },
            error: null,
          }),
        })),
      })),
      update,
    };
  });
  return { db: { from } as unknown as SupabaseClient, state, update };
}

test("returns the existing stripe_customer_id and does not call Stripe", async () => {
  const stripe = fakeStripe();
  const { db } = fakeDb({ name: "Acme", stripe_customer_id: "cus_existing" });
  const id = await ensureStripeCustomer(stripe, db, "spon_1");
  expect(id).toBe("cus_existing");
  expect(stripe.customers.create).not.toHaveBeenCalled();
});

test("creates a Stripe customer (name + metadata.sponsor_id), persists conditionally, and returns the new id", async () => {
  const stripe = fakeStripe();
  const { db, state, update } = fakeDb({ name: "Acme", stripe_customer_id: null });
  const id = await ensureStripeCustomer(stripe, db, "spon_1");
  expect(id).toBe("cus_new");
  const createArgs = (stripe.customers.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
    name: string;
    metadata: { sponsor_id: string };
  };
  expect(createArgs.name).toBe("Acme");
  expect(createArgs.metadata.sponsor_id).toBe("spon_1");
  expect(update).toHaveBeenCalledWith({ stripe_customer_id: "cus_new" });
  expect(state.stripe_customer_id).toBe("cus_new"); // persisted
});

test("CAUSE J: when a concurrent writer wins the race, returns the WINNER's id instead of the one this call just created", async () => {
  // Simulates: two concurrent ensureStripeCustomer calls both read stripe_customer_id: null, both
  // create a Stripe customer, but only ONE update actually lands (the conditional .is(...) WHERE
  // clause means the second call's update affects zero rows). This call created "cus_orphan" but
  // loses the race to "cus_winner", which some other process already persisted first.
  const stripe = fakeStripe({
    customers: { create: vi.fn().mockResolvedValue({ id: "cus_orphan" }) },
  } as never);
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const { db, state, update } = fakeDb(
    { name: "Acme", stripe_customer_id: null },
    { concurrentWriterId: "cus_winner" }
  );

  const id = await ensureStripeCustomer(stripe, db, "spon_1");

  // The conditional update was attempted (with the orphaned id)...
  expect(update).toHaveBeenCalledWith({ stripe_customer_id: "cus_orphan" });
  // ...but affected zero rows, so the row still shows the WINNER's id, and ensureStripeCustomer
  // returns THAT id, not the one it just created.
  expect(state.stripe_customer_id).toBe("cus_winner");
  expect(id).toBe("cus_winner");

  // Best-effort log so the orphaned Stripe customer can be found/cleaned up manually.
  expect(consoleError).toHaveBeenCalled();
  const loggedArgs = consoleError.mock.calls[0].join(" ");
  expect(loggedArgs).toContain("cus_orphan");
  consoleError.mockRestore();
});
