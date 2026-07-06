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
import { countActiveMembers, syncSubscriptionSeats } from "@/lib/billing/seats";
import { createPortalSession } from "@/lib/billing/portal";
import { createServiceRoleClient } from "@/lib/supabase/service";

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
 * including for past_due/incomplete), do NOT start a second one — route the admin to the Customer
 * Portal (openBillingPortal, Task 11) to manage/fix the existing subscription instead of creating
 * another. The final redirect(s) run OUTSIDE the try/catch (redirect throws a control signal, so it
 * must not be swallowed); openBillingPortal itself redirects, so returning it here satisfies that.
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
      // A subscription already exists — send the admin to manage/fix it in the Customer Portal
      // instead of creating a second one (F13). openBillingPortal redirects itself.
      return openBillingPortal(new FormData());
    }
    throw err;
  }

  redirect(checkoutUrl);
}

/**
 * Open the Stripe Customer Portal for the current sponsor. Role-gated; resolves the app origin from
 * the request headers so the portal returns the admin to /sponsor/billing. Injects a REAL Stripe
 * client (createStripeClient) — tests mock this module, never construct a real client.
 */
export async function openBillingPortal(_formData: FormData): Promise<void> {
  const { sponsorId } = await requireSponsorAdmin();
  const supabase = await createServerClient();
  const origin = (await headers()).get("origin") ?? "";
  const { url } = await createPortalSession(createStripeClient(), supabase, {
    sponsorId,
    returnUrl: `${origin}/sponsor/billing`,
  });
  redirect(url);
}

/**
 * Soft-remove a cohort member (status -> 'removed'), then reconcile the sponsor's Stripe seat
 * count so the sponsor stops paying for the freed seat.
 *
 * requireSponsorAdmin() runs FIRST and is the sole authorization gate: it resolves sponsorId from
 * the caller's own sponsor_admins row, so nothing here trusts client-supplied sponsor data.
 *
 * The actual write goes through the SERVICE-ROLE client, not the admin's RLS-scoped
 * createServerClient. Migration 0007 revoked UPDATE on cohort_members from `authenticated` and
 * granted back only the two consent columns (consent_share_skills, consent_share_credentials) —
 * that column-privilege grant binds ALL authenticated users, including sponsor admins. A
 * status='removed' write under the RLS client would fail with Postgres 42501, exactly like the
 * bug the accept-invite flow (Task 6) hit against sponsors.seats. So: authorize under RLS
 * (requireSponsorAdmin), then perform the privileged write with the service-role client — mirroring
 * acceptInvite's pattern in app/invite/[token]/actions.ts. The WHERE clause still pins BOTH
 * sponsor_id and earner_id so an admin can only ever affect their own org's membership row, even
 * though the service-role client itself bypasses RLS.
 *
 * Seat sync runs on the same service-role client afterward (mirrors the accept-flow pattern) and is
 * best-effort: wrapped in try/catch so a Stripe hiccup can never turn a successful removal into a
 * failure. This is safe because the webhook's customer.subscription.updated handler also calls
 * syncSubscriptionSeats on every update it processes — a genuinely operative backstop: Stripe fires
 * 'updated' on essentially any subscription mutation, so a dropped call here still self-heals the
 * next time Stripe reports on the subscription (e.g. from the quantity change this removal itself
 * would trigger once retried, or any other edit).
 */
export async function removeMember(formData: FormData): Promise<void> {
  const { sponsorId } = await requireSponsorAdmin();
  const earnerId = String(formData.get("earnerId") ?? "").trim();
  if (!earnerId) redirect("/sponsor/cohort?error=missing_member");

  const admin = createServiceRoleClient();
  const { error } = await admin
    .from("cohort_members")
    .update({ status: "removed" })
    .eq("sponsor_id", sponsorId)
    .eq("earner_id", earnerId);
  if (error) redirect("/sponsor/cohort?error=remove_failed");

  try {
    await syncSubscriptionSeats(createStripeClient(), admin, sponsorId);
  } catch (syncError) {
    console.error("[removeMember] seat sync failed (best-effort, removal already committed):", syncError);
  }

  revalidatePath("/sponsor/cohort");
  redirect("/sponsor/cohort");
}
