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
function fakeDb(row: { name: string; stripe_customer_id: string | null }) {
  const state = { ...row };
  const update = vi.fn((patch: Record<string, unknown>) => {
    Object.assign(state, patch);
    return { eq: vi.fn().mockResolvedValue({ error: null }) };
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

test("creates a Stripe customer (name + metadata.sponsor_id), persists, and returns the new id", async () => {
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
