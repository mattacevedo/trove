"use server";

import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { requireUserId } from "@/lib/auth/require-user";
import { provisionEarner } from "@/lib/auth/provision-earner";
import { createStripeClient } from "@/lib/billing/stripe";
import { syncSubscriptionSeats } from "@/lib/billing/seats";
import { createServiceRoleClient } from "@/lib/supabase/service";

export async function acceptInvite(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "").trim();
  if (!token) redirect("/invite?error=1");

  const userId = await requireUserId(); // -> /login if unauthed
  const supabase = await createServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user?.email) {
    // idempotent: creates the earners row iff the invitee is brand new
    await provisionEarner(supabase, userId, user.email);
  }

  const { data: sponsorId, error } = await supabase.rpc("accept_cohort_invite", {
    invite_token: token,
  });
  if (error || !sponsorId) redirect(`/invite/${token}?error=1`);

  // The RPC above already durably committed the membership. Everything from here is best-effort:
  // seat sync must NEVER be able to turn a successful accept into a failure.
  //
  // It must run on a SERVICE-ROLE client, not the earner's RLS-scoped `supabase`: migration 0008
  // revoked the authenticated role's UPDATE on sponsors except stripe_customer_id, so the
  // unconditional sponsors.seats write inside syncSubscriptionSeats would hit Postgres 42501 under
  // the earner's client. The earner's client is also wrong for the read side — cohort_members'
  // earner-select RLS policy only exposes the caller's own row, so countActiveMembers would
  // undercount every time. The service-role client bypasses RLS for both.
  //
  // It is also wrapped in try/catch: syncSubscriptionSeats makes a live Stripe call, and a Stripe
  // outage (or any other failure here) must not lose an already-accepted membership. On failure we
  // log and fall through to the same redirect. This is safe because the webhook's
  // customer.subscription.updated handler ALSO calls syncSubscriptionSeats on every update it
  // processes (lib/billing/webhook.ts) — a genuinely operative backstop, not a hypothetical one:
  // Stripe fires 'updated' on essentially any subscription mutation, including a quantity edit made
  // outside this flow entirely (the Stripe Dashboard, the Customer Portal), so seats self-heal even
  // when this best-effort call fails outright.
  try {
    const admin = createServiceRoleClient();
    await syncSubscriptionSeats(createStripeClient(), admin, sponsorId as string);
  } catch (syncError) {
    console.error("[acceptInvite] seat sync failed (best-effort, membership already committed):", syncError);
  }

  redirect("/app");
}
