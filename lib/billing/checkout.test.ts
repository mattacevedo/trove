import { expect, test, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StripeLike } from "./types";
import { createCheckoutSession, SubscriptionAlreadyExistsError } from "./checkout";

function fakeStripe(sessionUrl: string | null): {
  stripe: StripeLike;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn().mockResolvedValue({ id: "cs_1", url: sessionUrl });
  const stripe = {
    customers: { create: vi.fn().mockResolvedValue({ id: "cus_new" }) },
    checkout: { sessions: { create } },
    billingPortal: { sessions: { create: vi.fn() } },
    subscriptions: { retrieve: vi.fn(), update: vi.fn() },
    invoices: { list: vi.fn() },
    webhooks: { constructEvent: vi.fn() },
  } as unknown as StripeLike;
  return { stripe, create };
}

// The sponsors row read now includes stripe_subscription_id so the F13 no-second-subscription guard
// can be exercised. Default subscriptionId is null (no existing subscription -> Checkout allowed).
function fakeDb(stripeCustomerId: string | null, subscriptionId: string | null = null) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn().mockResolvedValue({
            data: {
              name: "Acme",
              stripe_customer_id: stripeCustomerId,
              stripe_subscription_id: subscriptionId,
            },
            error: null,
          }),
        })),
      })),
      update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })),
    })),
  } as unknown as SupabaseClient;
}

test("creates a subscription-mode session with the price+quantity line item and returns url", async () => {
  const { stripe, create } = fakeStripe("https://checkout.stripe.com/c/pay/cs_1");
  const db = fakeDb("cus_existing"); // no existing subscription
  const out = await createCheckoutSession(stripe, db, {
    sponsorId: "spon_1",
    priceId: "price_123",
    quantity: 7,
    successUrl: "https://app.example.com/sponsor/billing?ok=1",
    cancelUrl: "https://app.example.com/sponsor/billing?cancel=1",
  });
  expect(out.url).toBe("https://checkout.stripe.com/c/pay/cs_1");
  const args = create.mock.calls[0][0] as {
    mode: string;
    customer: string;
    line_items: Array<{ price: string; quantity: number }>;
    success_url: string;
    cancel_url: string;
  };
  expect(args.mode).toBe("subscription");
  expect(args.customer).toBe("cus_existing");
  expect(args.line_items).toEqual([{ price: "price_123", quantity: 7 }]);
  expect(args.success_url).toBe("https://app.example.com/sponsor/billing?ok=1");
  expect(args.cancel_url).toBe("https://app.example.com/sponsor/billing?cancel=1");
});

test("throws SubscriptionAlreadyExistsError and does NOT create a session when a subscription exists (F13)", async () => {
  const { stripe, create } = fakeStripe("https://checkout.stripe.com/c/pay/cs_1");
  // A past_due subscription still means one EXISTS — do not start a second; route to Portal.
  const db = fakeDb("cus_existing", "sub_pastdue");
  await expect(
    createCheckoutSession(stripe, db, {
      sponsorId: "spon_1",
      priceId: "price_123",
      quantity: 1,
      successUrl: "https://app.example.com/ok",
      cancelUrl: "https://app.example.com/cancel",
    })
  ).rejects.toBeInstanceOf(SubscriptionAlreadyExistsError);
  expect(create).not.toHaveBeenCalled();
});

test("throws when Stripe returns a null session url", async () => {
  const { stripe } = fakeStripe(null);
  const db = fakeDb("cus_existing");
  await expect(
    createCheckoutSession(stripe, db, {
      sponsorId: "spon_1",
      priceId: "price_123",
      quantity: 1,
      successUrl: "https://app.example.com/ok",
      cancelUrl: "https://app.example.com/cancel",
    })
  ).rejects.toThrow(/checkout session url/i);
});
