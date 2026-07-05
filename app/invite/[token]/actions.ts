"use server";

import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { requireUserId } from "@/lib/auth/require-user";
import { provisionEarner } from "@/lib/auth/provision-earner";
import { createStripeClient } from "@/lib/billing/stripe";
import { syncSubscriptionSeats } from "@/lib/billing/seats";

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

  // Keep the Stripe subscription quantity == active member count.
  // syncSubscriptionSeats short-circuits (skipped:true) when the sponsor has no
  // subscription yet, so this is safe to call on every accept.
  await syncSubscriptionSeats(createStripeClient(), supabase, sponsorId as string);

  redirect("/app");
}
