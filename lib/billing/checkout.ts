import type { SupabaseClient } from "@supabase/supabase-js";
import type { StripeLike } from "./types";
import { ensureStripeCustomer } from "./customer";

/**
 * Thrown when a sponsor already has a subscription and therefore must NOT start a second one via
 * Checkout. The caller (startCheckout action) catches this and routes the admin to the Customer
 * Portal to fix payment / manage the EXISTING subscription instead. Carrying a discriminable name
 * lets the action branch on it without string-matching the message.
 */
export class SubscriptionAlreadyExistsError extends Error {
  readonly code = "subscription_exists";
  constructor(public readonly stripeSubscriptionId: string) {
    super(`sponsor already has subscription ${stripeSubscriptionId}`);
    this.name = "SubscriptionAlreadyExistsError";
  }
}

/**
 * Create a subscription-mode Stripe Checkout session for a sponsor's seat subscription. The single
 * line item pins the seat price and the seat quantity (the caller passes the active-member count).
 *
 * Guards against a SECOND subscription (F13): if the sponsor row already has a
 * stripe_subscription_id (even in past_due/incomplete), this throws SubscriptionAlreadyExistsError
 * instead of creating another subscription — the admin should fix the existing one in the Portal.
 *
 * Returns the hosted Checkout url; throws if Stripe omits it (a Checkout session with no url cannot
 * be redirected to and indicates a misconfiguration rather than a normal outcome).
 */
export async function createCheckoutSession(
  stripe: StripeLike,
  db: SupabaseClient,
  args: {
    sponsorId: string;
    priceId: string;
    quantity: number;
    successUrl: string;
    cancelUrl: string;
  }
): Promise<{ url: string }> {
  // Read the current subscription state BEFORE creating anything.
  const { data: sponsor, error } = await db
    .from("sponsors")
    .select("stripe_subscription_id")
    .eq("id", args.sponsorId)
    .single();
  if (error) throw error;
  const existingSub = (sponsor?.stripe_subscription_id as string | null) ?? null;
  if (existingSub) throw new SubscriptionAlreadyExistsError(existingSub);

  const customerId = await ensureStripeCustomer(stripe, db, args.sponsorId);

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: args.priceId, quantity: args.quantity }],
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
  });

  if (!session.url) {
    throw new Error("Stripe returned a checkout session url of null");
  }
  return { url: session.url };
}
