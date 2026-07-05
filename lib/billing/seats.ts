// lib/billing/seats.ts
// Single source of truth for a sponsor's billable seat count and its reconciliation with Stripe.
// See .superpowers/sdd/task-13-brief.md for the full design (F11 echo-loop guard, F12 sole-writer rule).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { StripeLike } from "@/lib/billing/types";

/**
 * Single source of truth for a sponsor's billable seat count: the number of cohort_members
 * whose status is 'active'. Head-count query (no rows returned). Any inlined active-member
 * count elsewhere (Task 10 checkout quantity, Task 6 accept flow) must route through this.
 */
export async function countActiveMembers(
  db: SupabaseClient,
  sponsorId: string
): Promise<number> {
  const { count, error } = await db
    .from("cohort_members")
    .select("*", { count: "exact", head: true })
    .eq("sponsor_id", sponsorId)
    .eq("status", "active");
  if (error) throw error;
  return count ?? 0;
}

/**
 * Reconcile the Stripe subscription's seat quantity with the live active-member count. This is the
 * SINGLE source of truth for sponsors.seats — after computing the authoritative active count it
 * writes that count back to sponsors.seats, so no other code path (webhook payload, checkout) writes
 * seats. That keeps DB seats == active count == Stripe quantity in lockstep.
 *
 * - If the sponsor has no subscription yet (stripe_subscription_id null), do NOT touch Stripe, but
 *   still persist sponsors.seats = quantity and return { quantity, skipped: true }. Checkout (Task 10)
 *   is what first creates the subscription; until then there is nothing to sync in Stripe.
 * - Otherwise retrieve the subscription and take its single line item. If the item's current quantity
 *   ALREADY equals the active count, do NOT call subscriptions.update — this breaks the echo loop
 *   where a subscription.updated webhook triggers a reconcile that would otherwise emit another
 *   update (and another webhook) forever. Only when they differ do we update with create_prorations.
 *
 * Called on every membership change: invite-accept (Task 6), member-remove (Task 13's
 * app/sponsor action), and reconciled inside handleStripeEvent for customer.subscription.updated.
 */
export async function syncSubscriptionSeats(
  stripe: StripeLike,
  db: SupabaseClient,
  sponsorId: string
): Promise<{ quantity: number; skipped: boolean }> {
  const quantity = await countActiveMembers(db, sponsorId);

  const { data: sponsor, error } = await db
    .from("sponsors")
    .select("stripe_subscription_id")
    .eq("id", sponsorId)
    .maybeSingle();
  if (error) throw error;

  // Reconciliation is the sole writer of sponsors.seats — persist the authoritative count regardless
  // of whether a Stripe subscription exists yet.
  const { error: seatsError } = await db
    .from("sponsors")
    .update({ seats: quantity })
    .eq("id", sponsorId);
  if (seatsError) throw seatsError;

  const subscriptionId = sponsor?.stripe_subscription_id as string | null | undefined;
  if (!subscriptionId) return { quantity, skipped: true };

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const item = subscription.items.data[0];
  if (!item) return { quantity, skipped: true };

  // Idempotency / echo-loop break: if Stripe already reflects the active count, do not update.
  if (item.quantity === quantity) return { quantity, skipped: true };

  await stripe.subscriptions.update(subscriptionId, {
    items: [{ id: item.id, quantity }],
    proration_behavior: "create_prorations",
  });

  return { quantity, skipped: false };
}
