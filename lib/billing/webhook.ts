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
//   • Out-of-order safety, two layers, for customer.subscription.updated:
//       1. LOCAL terminality guard: we resolve the sponsor row FIRST (by stripe_customer_id) and
//          compare the event's subscription id against the sponsor's CURRENT
//          stripe_subscription_id. If it's null or different, the event is stale relative to what
//          we already know (e.g. a .deleted for that exact sub already cleared/replaced it) and we
//          bail with { handled: false } WITHOUT calling Stripe or writing anything. This does not
//          depend on Stripe ever refusing to return "active" for an old subscription id.
//       2. LIVE read: once the id matches, we still resolve the LIVE subscription via
//          subscriptions.retrieve and write ITS authoritative status/plan — the event payload's
//          status is never trusted, and neither is its price: plan is derived from
//          planForPriceId(<LIVE item's price id>), falling back to the event payload's price only
//          if the live item lacks one (defensive — StripeLike types price as optional).
//   • Terminal delete: customer.subscription.deleted sets 'canceled' + clears the id. Combined with
//     the local terminality guard above, a later 'updated' for that same (now-stale) subscription id
//     cannot resurrect it — regardless of what its live retrieve reports.
//   • Plan label comes from the stable PLAN_BY_PRICE_ID map (price.id), never price.nickname.
//   • Seats: sponsors.seats is written EXCLUSIVELY by syncSubscriptionSeats (lib/billing/seats.ts) —
//     this module never writes the `seats` column directly. customer.subscription.updated calls
//     syncSubscriptionSeats AFTER its own status/plan write (both the live-active write and the
//     "not live" cleared-to-canceled write), reusing the same `stripe`/`db` already in scope, so
//     seats self-heal on essentially any subscription mutation Stripe reports — including a manual
//     quantity edit in the Stripe Dashboard/Portal that never went through our own invite/remove
//     flows. It is NOT called on the stale/local-terminality-guard early return (the event is a no-op
//     there) nor from customer.subscription.created/deleted (Tasks 6/13's app-level best-effort calls
//     and the next updated event cover those transitions). The echo-loop guard lives inside
//     syncSubscriptionSeats itself (skip the Stripe update when its quantity already matches), so
//     calling it here on every updated event cannot create a webhook feedback loop.
//   • Unknown customers: created/updated/invoice.* all resolve the sponsor row FIRST and return
//     { handled: false } (no write, no throw) when the Stripe customer id matches no sponsor —
//     consistent treatment across every branch that keys off stripe_customer_id.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createStripeClient, planForPriceId } from "@/lib/billing/stripe";
import { syncSubscriptionSeats } from "@/lib/billing/seats";

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

/** Resolve {id, stripe_subscription_id} for a Stripe customer; null if no sponsor matches. */
async function sponsorForCustomer(
  db: SupabaseClient,
  customerId: string
): Promise<{ id: string; stripeSubscriptionId: string | null } | null> {
  const { data, error } = await db
    .from("sponsors")
    .select("id, stripe_subscription_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  if (error) throw new Error(`sponsor lookup failed: ${error.message}`);
  if (!data) return null;
  return {
    id: data.id as string,
    stripeSubscriptionId: (data.stripe_subscription_id as string | null) ?? null,
  };
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

      // Consistent with updated/invoice: resolve the sponsor first. An unknown customer is not an
      // error (e.g. test-mode noise, a customer created outside our flow) — handled:false, no write.
      const sponsor = await sponsorForCustomer(db, customerId);
      if (!sponsor) return { handled: false };

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

      const sponsor = await sponsorForCustomer(db, customerId);
      if (!sponsor) return { handled: false };

      // Local terminality guard (independent of whatever Stripe's live retrieve reports): if the
      // sponsor's CURRENT stripe_subscription_id is null or differs from this event's subscription,
      // the event is stale relative to what we already know locally (e.g. a .deleted for this exact
      // sub already cleared/replaced it). Do NOT write status/plan/sub id in that case — a NEW
      // subscription still activates via the created branch above, which sets the new sub id first.
      if (sponsor.stripeSubscriptionId === null || sponsor.stripeSubscriptionId !== subscriptionId) {
        return { handled: false };
      }

      // Out-of-order safety: read the LIVE subscription, not the (possibly stale) event payload.
      const stripe = createStripeClient();
      let live: {
        status: string;
        items: { data: Array<{ id: string; quantity?: number; price?: { id: string } }> };
      } | null;
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

      // Status AND plan are both derived from the LIVE object — the event payload is never trusted
      // for either. `firstPriceId` reads whichever object it is given; pass the LIVE item's price so
      // plan tracks the authoritative subscription, falling back to the event payload's price only
      // if the live item is missing one (defensive — StripeLike types price as optional).
      const livePriceId = firstPriceId(live) ?? firstPriceId(object);
      await updateSponsorByCustomer(db, customerId, {
        subscription_status: live.status,
        stripe_subscription_id: subscriptionId,
        plan: planForPriceId(livePriceId),
      });

      // Reconcile seats now that we've confirmed the live status/plan. Stripe fires 'updated' on
      // essentially any subscription mutation (quantity changes included), so this keeps
      // sponsors.seats and the Stripe item quantity in lockstep even when neither drifted via our
      // own invite/remove flows. syncSubscriptionSeats' own echo-guard (skip the Stripe update when
      // its quantity already matches) is what prevents this from looping.
      await syncSubscriptionSeats(stripe, db, sponsor.id);
      return { handled: true };
    }

    case "customer.subscription.deleted": {
      const customerId = asString(object.customer);
      if (!customerId) return { handled: false };
      // Terminal: canceled + cleared id. A later stale 'updated' for this same subscription id
      // cannot re-activate it — the updated branch's local terminality guard rejects any event whose
      // subscription id no longer matches the sponsor's current stripe_subscription_id (now null).
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
