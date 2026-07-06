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
 *
 * CAUSE J — first-writer-wins race: the read-then-write above has a window where two concurrent
 * calls can both see stripe_customer_id: null, both create a REAL Stripe customer, and an
 * unconditional update would let the second write silently overwrite the first — orphaning whichever
 * Stripe customer "loses", with no sponsor row ever pointing at it again. The persist below is
 * therefore conditional on the column STILL being null (`.is("stripe_customer_id", null)`). If that
 * update affects zero rows, some other caller already won the race: re-read the row and return ITS
 * (the winner's) id instead of the one this call just created, and log the orphan's id so it can be
 * found and cleaned up manually in the Stripe dashboard.
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

  const { data: updatedRows, error: updateError } = await db
    .from("sponsors")
    .update({ stripe_customer_id: customer.id })
    .eq("id", sponsorId)
    .is("stripe_customer_id", null)
    .select();
  if (updateError) throw updateError;

  if (!updatedRows || updatedRows.length === 0) {
    // Lost the race: someone else's update landed first. Re-read to find the winning id.
    const { data: reread, error: rereadError } = await db
      .from("sponsors")
      .select("stripe_customer_id")
      .eq("id", sponsorId)
      .single();
    if (rereadError) throw rereadError;
    const winnerId = (reread?.stripe_customer_id as string | null) ?? null;
    console.error(
      `[ensureStripeCustomer] lost a create-customer race for sponsor ${sponsorId}: ` +
        `created orphan Stripe customer ${customer.id} (manual cleanup needed); ` +
        `using existing ${winnerId ?? "<none>"} instead.`
    );
    // winnerId should always be present here (some writer set it — that's WHY we lost the race),
    // but defensively fall back to our own id rather than returning an empty string if not.
    return winnerId ?? customer.id;
  }

  return customer.id;
}
