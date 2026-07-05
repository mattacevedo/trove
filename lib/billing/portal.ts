// Customer Portal + invoice listing for the Sponsor Console (Plan 6, Task 11).
// Both helpers take an injected StripeLike (never a concrete Stripe client) so tests supply a
// hand-written fake and NEVER read STRIPE_SECRET_KEY — mirrors the injectable adapter in
// lib/advisor/llm.ts. The only module allowed to import the real `stripe` package is
// lib/billing/stripe.ts; these helpers stay SDK-free.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { StripeLike } from "@/lib/billing/types";
import { ensureStripeCustomer } from "@/lib/billing/customer";

/**
 * Create a Stripe Customer Portal session so the sponsor admin can self-serve payment methods,
 * proration, cancellation, etc. Ensures the sponsor has a Stripe customer first (idempotent).
 */
export async function createPortalSession(
  stripe: StripeLike,
  db: SupabaseClient,
  args: { sponsorId: string; returnUrl: string }
): Promise<{ url: string }> {
  const customerId = await ensureStripeCustomer(stripe, db, args.sponsorId);
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: args.returnUrl,
  });
  return { url: session.url };
}
