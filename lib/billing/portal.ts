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

/**
 * List the sponsor's recent invoices (newest first, as Stripe returns them). Reads the persisted
 * stripe_customer_id; if the sponsor has never checked out there is no customer, so we short-circuit
 * to [] WITHOUT touching Stripe. Maps snake_case Stripe fields → the camelCase shape the UI expects.
 */
export async function listInvoices(
  stripe: StripeLike,
  db: SupabaseClient,
  sponsorId: string
): Promise<Array<{ id: string; status: string | null; amountPaid: number; hostedUrl: string | null; created: number }>> {
  const { data: sponsor } = await db
    .from("sponsors")
    .select("stripe_customer_id")
    .eq("id", sponsorId)
    .single();

  const customerId = (sponsor?.stripe_customer_id as string | null) ?? null;
  if (!customerId) return [];

  const result = await stripe.invoices.list({ customer: customerId, limit: 12 });
  return result.data.map((inv) => ({
    id: inv.id,
    status: inv.status,
    amountPaid: inv.amount_paid,
    hostedUrl: inv.hosted_invoice_url,
    created: inv.created,
  }));
}
