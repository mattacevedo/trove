import type { SupabaseClient } from "@supabase/supabase-js";
import type { StripeLike } from "./types";

/**
 * Idempotently resolve the Stripe customer id for a sponsor. Returns the persisted
 * sponsors.stripe_customer_id when present; otherwise creates a Stripe customer (named after the
 * sponsor, tagged with sponsor_id metadata for webhook reconciliation), writes the id back onto
 * the sponsor row, and returns it. The Supabase client MUST have privileges to update the row
 * (service-role in webhook contexts, or an RLS-authorized sponsor admin via sponsors_admin_update).
 * NOTE: 0008 narrows the authenticated UPDATE grant on sponsors to stripe_customer_id only;
 * entitlement columns (plan, seats, subscription_status, stripe_subscription_id) are
 * service-role-only (webhook) — an RLS-scoped client can write stripe_customer_id and nothing else.
 */
export async function ensureStripeCustomer(
  stripe: StripeLike,
  db: SupabaseClient,
  sponsorId: string
): Promise<string> {
  const { data, error } = await db
    .from("sponsors")
    .select("name, stripe_customer_id")
    .eq("id", sponsorId)
    .single();
  if (error) throw error;
  if (!data) throw new Error(`sponsor not found: ${sponsorId}`);

  const existing = (data.stripe_customer_id as string | null) ?? null;
  if (existing) return existing;

  const customer = await stripe.customers.create({
    name: (data.name as string) ?? "",
    metadata: { sponsor_id: sponsorId },
  });

  const { error: updateError } = await db
    .from("sponsors")
    .update({ stripe_customer_id: customer.id })
    .eq("id", sponsorId);
  if (updateError) throw updateError;

  return customer.id;
}
