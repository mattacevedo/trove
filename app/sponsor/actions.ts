"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { requireSponsorAdmin } from "@/lib/auth/require-sponsor-admin";
import { parseEmails } from "@/lib/cohort/parse-emails";
import { inviteCohort as inviteCohortLib } from "@/lib/cohort/invite";
import { createPostmarkSender } from "@/lib/email/postmark";

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
