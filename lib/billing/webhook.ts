// lib/billing/webhook.ts
// Stripe webhook event dispatcher (Plan 6). This module does NOT verify signatures — the route
// (app/api/stripe/webhook/route.ts) verifies via StripeLike.webhooks.constructEvent and hands us
// the parsed event (with its id). It does NOT import the `stripe` package directly; when it needs a
// Stripe client (to read the LIVE subscription truth) it goes through createStripeClient() from
// lib/billing/stripe.ts — the sole allowlisted SDK importer. All DB writes use the injected
// service-role Supabase client (bypasses RLS — that is why Task 1 added no sponsors UPDATE policy).
//
// Correctness invariants baked in here:
//   • Idempotency: we INSERT event.id into stripe_events FIRST; a duplicate (23505) short-circuits
//     with { handled: true } and NO side effects, so retried/duplicated deliveries apply once.
//   • Out-of-order safety: for customer.subscription.updated we resolve the LIVE subscription via
//     subscriptions.retrieve and write its authoritative status — a stale event payload never wins.
//   • Terminal delete: customer.subscription.deleted sets 'canceled' + clears the id; and an
//     'updated' whose live retrieve reports canceled/not-found does NOT resurrect the subscription.
//   • Plan label comes from the stable PLAN_BY_PRICE_ID map (price.id), never price.nickname.
//   • Seats are NOT written here — reconciliation (Task 13, syncSubscriptionSeats) is the SOLE
//     writer of sponsors.seats.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createStripeClient, planForPriceId } from "@/lib/billing/stripe";

/** Narrow a loose JSON value to a non-empty string, or return null. */
function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Read the first subscription item's price id from a loose subscription-like object. */
function firstPriceId(object: Record<string, unknown>): string | null {
  const items = object.items as { data?: Array<Record<string, unknown>> } | undefined;
  const price = items?.data?.[0]?.price as { id?: unknown } | undefined;
  return asString(price?.id);
}

/** Resolve the sponsor id for a Stripe customer; null if no sponsor matches. */
async function sponsorIdForCustomer(
  db: SupabaseClient,
  customerId: string
): Promise<string | null> {
  const { data, error } = await db
    .from("sponsors")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  if (error) throw new Error(`sponsor lookup failed: ${error.message}`);
  return (data?.id as string | undefined) ?? null;
}

/** Apply an update to the sponsors row matched by stripe_customer_id; throw on PostgREST error. */
async function updateSponsorByCustomer(
  db: SupabaseClient,
  customerId: string,
  values: Record<string, unknown>
): Promise<void> {
  const { error } = await db.from("sponsors").update(values).eq("stripe_customer_id", customerId);
  if (error) throw new Error(`sponsors update failed: ${error.message}`);
}

/**
 * Record this event id in the idempotency ledger. Returns true if it is NEW (first time we see it),
 * false if it is a DUPLICATE (unique violation 23505) that we must not re-apply.
 */
async function recordEvent(db: SupabaseClient, eventId: string): Promise<boolean> {
  const { error } = await db.from("stripe_events").insert({ id: eventId });
  if (!error) return true;
  if (error.code === "23505") return false; // already processed
  throw new Error(`stripe_events insert failed: ${error.message}`);
}

export async function handleStripeEvent(
  db: SupabaseClient,
  event: { id: string; type: string; data: { object: Record<string, unknown> } }
): Promise<{ handled: boolean }> {
  const object = event.data.object;

  // Idempotency FIRST — a duplicate delivery returns handled with no side effects.
  const eventId = asString(event.id);
  if (eventId) {
    const isNew = await recordEvent(db, eventId);
    if (!isNew) return { handled: true };
  }

  switch (event.type) {
    case "customer.subscription.created": {
      const customerId = asString(object.customer);
      const subscriptionId = asString(object.id);
      const status = asString(object.status);
      if (!customerId || !subscriptionId || !status) return { handled: false };
      const values: Record<string, unknown> = {
        subscription_status: status,
        stripe_subscription_id: subscriptionId,
        plan: planForPriceId(firstPriceId(object)),
      };
      await updateSponsorByCustomer(db, customerId, values);
      return { handled: true };
    }

    case "customer.subscription.updated": {
      const customerId = asString(object.customer);
      const subscriptionId = asString(object.id);
      if (!customerId || !subscriptionId) return { handled: false };

      const sponsorId = await sponsorIdForCustomer(db, customerId);
      if (!sponsorId) return { handled: false };

      // Out-of-order safety: read the LIVE subscription, not the (possibly stale) event payload.
      const stripe = createStripeClient();
      let live: { status: string; items: { data: Array<{ id: string; quantity?: number }> } } | null;
      try {
        live = await stripe.subscriptions.retrieve(subscriptionId);
      } catch {
        live = null; // not found -> treat as terminal below
      }

      // A stale 'updated' arriving after cancellation must NOT resurrect the subscription.
      if (!live || live.status === "canceled" || live.status === "incomplete_expired") {
        await updateSponsorByCustomer(db, customerId, {
          subscription_status: "canceled",
          stripe_subscription_id: null,
        });
        return { handled: true };
      }

      // Authoritative status/plan from the live object. Seats are NOT written here — Task 13's
      // reconciliation (appended below in that task) is the sole writer of sponsors.seats.
      await updateSponsorByCustomer(db, customerId, {
        subscription_status: live.status,
        stripe_subscription_id: subscriptionId,
        plan: planForPriceId(firstPriceId(object)),
      });
      return { handled: true };
    }

    case "customer.subscription.deleted": {
      const customerId = asString(object.customer);
      if (!customerId) return { handled: false };
      // Terminal: canceled + cleared id. A later stale 'updated' cannot re-activate (its live
      // retrieve returns canceled/not-found, which the updated branch also treats as terminal).
      await updateSponsorByCustomer(db, customerId, {
        subscription_status: "canceled",
        stripe_subscription_id: null,
      });
      return { handled: true };
    }

    case "invoice.paid":
    case "invoice.payment_failed": {
      const customerId = asString(object.customer);
      const invoiceSub = asString(object.subscription);
      const billingReason = asString(object.billing_reason);
      if (!customerId) return { handled: false };

      // Correlate: only act on subscription lifecycle invoices AND when the invoice's subscription
      // matches the sponsor's current stripe_subscription_id. Otherwise ignore (a one-off invoice,
      // a proration for a different sub, etc.). customer.subscription.updated is the authoritative
      // status source; invoice events are a secondary signal.
      if (billingReason !== "subscription_cycle" && billingReason !== "subscription_create") {
        return { handled: false };
      }
      const { data: sponsor, error } = await db
        .from("sponsors")
        .select("stripe_subscription_id")
        .eq("stripe_customer_id", customerId)
        .maybeSingle();
      if (error) throw new Error(`sponsor lookup failed: ${error.message}`);
      const currentSub = (sponsor?.stripe_subscription_id as string | null) ?? null;
      if (!invoiceSub || !currentSub || invoiceSub !== currentSub) return { handled: false };

      await updateSponsorByCustomer(db, customerId, {
        subscription_status: event.type === "invoice.paid" ? "active" : "past_due",
      });
      return { handled: true };
    }

    default:
      return { handled: false };
  }
}
