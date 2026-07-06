// app/api/stripe/webhook/route.ts
// Stripe webhook receiver (Plan 6). Verifies the Stripe signature over the RAW request body, then
// dispatches the parsed event to handleStripeEvent using a SERVICE-ROLE Supabase client (RLS is
// bypassed — the caller is Stripe, not an authenticated sponsor admin). The exported POST composes
// the real dependencies; the internal handlePost(request, deps) seam takes them as parameters so
// route.test.ts can inject a fake StripeLike + fake db and never read STRIPE_WEBHOOK_SECRET or
// construct a real client.

import { NextResponse, type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createStripeClient } from "@/lib/billing/stripe";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { handleStripeEvent } from "@/lib/billing/webhook";
import type { StripeLike } from "@/lib/billing/types";

// Stripe signs the exact bytes it POSTs; Next must not parse/transform the body first.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export interface WebhookDeps {
  stripe: StripeLike;
  db: SupabaseClient;
  webhookSecret: string;
}

/** Testable core: verify signature over the raw body, dispatch, map to 200/400. */
export async function handlePost(
  request: NextRequest,
  deps: WebhookDeps
): Promise<NextResponse> {
  const rawBody = await request.text(); // RAW bytes — must precede any parsing.
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "missing signature" }, { status: 400 });
  }

  let event: { id: string; created: number; type: string; data: { object: Record<string, unknown> } };
  try {
    event = deps.stripe.webhooks.constructEvent(rawBody, signature, deps.webhookSecret);
  } catch {
    // Signature mismatch / malformed payload — Stripe expects a 400 so it will retry.
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  try {
    await handleStripeEvent(deps.db, event);
  } catch (err) {
    // A thrown error here (e.g. a PostgREST failure) means the event was NOT durably applied. Map
    // it to a 500 so Stripe's automatic retry logic re-delivers this event, instead of letting the
    // exception escape as an unmapped framework-level 500 (which happens to also be a 500, but is
    // not something this route asserts or controls the shape of).
    console.error("[stripe webhook] handleStripeEvent threw:", err);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
  return NextResponse.json({ received: true }, { status: 200 });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handlePost(request, {
    stripe: createStripeClient(),
    db: createServiceRoleClient(),
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
  });
}
