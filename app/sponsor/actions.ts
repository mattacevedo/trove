"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { requireSponsorAdmin } from "@/lib/auth/require-sponsor-admin";
import { parseEmails } from "@/lib/cohort/parse-emails";
import { inviteCohort as inviteCohortLib } from "@/lib/cohort/invite";
import { createPostmarkSender } from "@/lib/email/postmark";
import { createStripeClient } from "@/lib/billing/stripe";
import { createCheckoutSession, SubscriptionAlreadyExistsError } from "@/lib/billing/checkout";
import { countActiveMembers } from "@/lib/billing/seats";

/**
 * Create a new sponsor organization for the current user via the create_sponsor RPC
 * (SECURITY DEFINER: inserts sponsors + sponsor_admins atomically), then open the dashboard.
 */
export async function createSponsor(formData: FormData): Promise<void> {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) redirect("/sponsor/new?error=name_required");

  const supabase = await createServerClient();
  const { error } = await supabase.rpc("create_sponsor", { sponsor_name: name });
  if (error) redirect("/sponsor/new?error=create_failed");

  redirect("/sponsor");
}

/**
 * Invite a cohort by email. Parses the 'emails' textarea, resolves the request origin so the
 * emailed link is absolute, and delegates to lib inviteCohort with the REAL Postmark sender
 * (constructed only here). The sponsor is resolved via requireSponsorAdmin (role-gate).
 */
export async function inviteCohort(formData: FormData): Promise<void> {
  const { sponsorId } = await requireSponsorAdmin();
  const raw = String(formData.get("emails") ?? "");
  const { valid } = parseEmails(raw);
  if (valid.length === 0) redirect("/sponsor/cohort?error=no_valid_emails");

  const supabase = await createServerClient();
  const { data: sponsor } = await supabase
    .from("sponsors")
    .select("name")
    .eq("id", sponsorId)
    .single();
  const sponsorName = (sponsor?.name as string | null) ?? "Your sponsor";

  const hdrs = await headers();
  const host = hdrs.get("host");
  const origin = hdrs.get("origin") ?? (host ? `https://${host}` : "");

  await inviteCohortLib(supabase, createPostmarkSender(), {
    sponsorId,
    sponsorName,
    emails: valid,
    origin,
  });

  revalidatePath("/sponsor/cohort");
  redirect("/sponsor/cohort");
}

/**
 * Begin a Stripe Checkout for the current sponsor's seat subscription. Quantity is the current
 * active-member count (minimum 1 so a brand-new org can still subscribe a seat). The price id is
 * environment-only (STRIPE_PRICE_ID); tests never read it because they exercise
 * createCheckoutSession directly with an injected fake StripeLike.
 *
 * Deviation from the Task 10 brief: the brief inlines the active-member count query here with a
 * `// TODO(Task 13): replace with countActiveMembers()` marker, on the premise that Task 13 has not
 * landed yet. On this branch, Task 13's core module (`lib/billing/seats.ts`, commit 83e3e05) already
 * landed early (to unblock Task 6's invite-accept flow) and is fully tested — so this action imports
 * `countActiveMembers` directly rather than duplicating its query. This is strictly the brief's own
 * end-state (a single source of truth for the active count), just realized immediately instead of via
 * a later refactor.
 *
 * F13: if a subscription already exists (createCheckoutSession throws SubscriptionAlreadyExistsError,
 * including for past_due/incomplete), do NOT start a second one — route the admin to manage the
 * existing subscription instead of creating another. Task 11 (not yet landed on this branch) will add
 * an `openBillingPortal` action in this same module; until then this redirects to a `?manage=1` query
 * param on /sponsor/billing as an honest placeholder — swap to `return openBillingPortal(new
 * FormData())` once Task 11 lands. The final redirect(s) run OUTSIDE the try/catch (redirect throws a
 * control signal, so it must not be swallowed).
 */
export async function startCheckout(): Promise<void> {
  const { sponsorId } = await requireSponsorAdmin();
  const supabase = await createServerClient();

  const activeCount = await countActiveMembers(supabase, sponsorId);
  const quantity = Math.max(activeCount, 1);

  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) redirect("/sponsor/billing?error=price_not_configured");

  const hdrs = await headers();
  const origin =
    hdrs.get("origin") ?? (hdrs.get("host") ? `https://${hdrs.get("host")}` : "");
  const billingUrl = `${origin}/sponsor/billing`;

  const stripe = createStripeClient();
  let checkoutUrl: string;
  try {
    const { url } = await createCheckoutSession(stripe, supabase, {
      sponsorId,
      priceId: priceId!,
      quantity,
      successUrl: `${billingUrl}?checkout=success`,
      cancelUrl: `${billingUrl}?checkout=cancel`,
    });
    checkoutUrl = url;
  } catch (err) {
    if (err instanceof SubscriptionAlreadyExistsError) {
      // A subscription already exists — send the admin to manage/fix it instead of creating a
      // second one. TODO(Task 11): swap for `return openBillingPortal(new FormData())` once that
      // action lands in this module.
      redirect("/sponsor/billing?manage=1");
    }
    throw err;
  }

  redirect(checkoutUrl);
}
