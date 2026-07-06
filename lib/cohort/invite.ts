// Cohort invitation logic. Pure of any concrete external SDK: it takes an injected `db`
// (SupabaseClient — service-role or RLS-scoped) and an injected `EmailSender` (Task 3), so
// invite.test.ts drives it with in-memory fakes and NO real Postmark/DB call. The action wrapper
// in app/sponsor/actions.ts is the only place that constructs the real sender.

import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CohortInvite, EmailSender } from "@/lib/billing/types";

/** URL-safe random invite token (32 bytes of entropy, base64url — no +, /, or = padding). */
export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Escapes the characters that matter for safe interpolation into HTML text content
 *  (& < > " '). Sponsor-supplied names are untrusted input — see inviteEmail below. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inviteEmail(sponsorName: string, link: string): { subject: string; htmlBody: string; textBody: string } {
  const subject = `${sponsorName} invited you to Trove`;
  const textBody =
    `${sponsorName} invited you to join their cohort on Trove — your free, standards-based ` +
    `credential wallet.\n\nAccept your invitation:\n${link}\n\n` +
    `You control what you share. Sponsors only see data you explicitly consent to.`;
  const safeSponsorName = escapeHtml(sponsorName);
  const htmlBody =
    `<p>${safeSponsorName} invited you to join their cohort on <strong>Trove</strong> — ` +
    `your free, standards-based credential wallet.</p>` +
    `<p><a href="${link}">Accept your invitation</a></p>` +
    `<p>You control what you share. Sponsors only see data you explicitly consent to.</p>`;
  return { subject, htmlBody, textBody };
}

/**
 * Result buckets, kept simple and honest about what actually happened to each address:
 *  - invited: a BRAND NEW cohort_invites row was created and an email went out.
 *  - resent: the address already had an OPEN (never-accepted) invite — no new row, the STORED token
 *    is reused (not rotated, so any copy of the original email link still works) and the email is
 *    re-sent. Kept distinct from `invited` so callers/tests can tell first-time sends from recovery
 *    resends of a possibly-lost original email.
 *  - skipped: the address already has an ACCEPTED invite (an active or otherwise-not-reopenable
 *    membership) — no email sent, no write.
 *  - failed: `sender.send` rejected for this address. The cohort_invites row (new or resent) was
 *    already committed/valid — only the email delivery failed — so the address is reported
 *    separately rather than aborting the rest of the batch.
 */
export async function inviteCohort(
  db: SupabaseClient,
  sender: EmailSender,
  args: { sponsorId: string; sponsorName: string; emails: string[]; origin: string }
): Promise<{ invited: CohortInvite[]; skipped: string[]; resent: string[]; failed: string[] }> {
  const invited: CohortInvite[] = [];
  const skipped: string[] = [];
  const resent: string[] = [];
  const failed: string[] = [];

  /** Best-effort send: on rejection, record the address as failed and keep processing the batch. */
  async function sendOrRecordFailure(
    email: string,
    subject: string,
    htmlBody: string,
    textBody: string
  ): Promise<void> {
    try {
      await sender.send({ to: email, subject, htmlBody, textBody });
    } catch (sendError) {
      console.error(`[inviteCohort] send failed for ${email} (continuing batch):`, sendError);
      failed.push(email);
    }
  }

  for (const email of args.emails) {
    const token = generateInviteToken();
    const { data, error } = await db
      .from("cohort_invites")
      .insert({ sponsor_id: args.sponsorId, email, token })
      .select("id, sponsor_id, email, token, accepted_at, created_at")
      .single();

    if (error) {
      // 23505 = unique_violation on unique(sponsor_id, email) => an invite for this address already
      // exists. Look it up to decide what actually happened rather than always skipping quietly.
      if (error.code === "23505") {
        const { data: existing, error: lookupError } = await db
          .from("cohort_invites")
          .select("id, token, accepted_at")
          .eq("sponsor_id", args.sponsorId)
          .eq("email", email)
          .single();
        if (lookupError) throw new Error(lookupError.message);

        if (!existing!.accepted_at) {
          // Never accepted: this is the recovery path for a lost/undelivered original email.
          // Reuse the STORED token (do not rotate it) so any surviving copy of the original link
          // still works, and resend.
          const link = `${args.origin}/invite/${existing!.token as string}`;
          const { subject, htmlBody, textBody } = inviteEmail(args.sponsorName, link);
          await sendOrRecordFailure(email, subject, htmlBody, textBody);
          resent.push(email);
          continue;
        }

        // Already accepted. cohort_invites is keyed by EMAIL, but cohort_members is keyed by
        // earner_id — the two tables are never directly joined, and the email -> earner_id mapping
        // lives only on auth.users (not directly readable by this RLS-scoped client). The
        // reinvite_cohort_member SECURITY DEFINER RPC (migration 0010) does the whole
        // check-then-rotate atomically: gated by is_sponsor_admin, it resolves the earner via
        // auth.users, checks whether their cohort_members row is 'removed', and — ONLY then — rotates
        // the invite's token and clears accepted_at in the same call (no window for a concurrent
        // accept/removal to race against). It returns zero rows for every other case (no account yet,
        // no membership row, or a still-active member), and this function never touches
        // cohort_members/auth.users directly.
        const candidateToken = generateInviteToken();
        const { data: reinvited, error: reinviteError } = await db.rpc("reinvite_cohort_member", {
          target_sponsor: args.sponsorId,
          invite_email: email,
          new_token: candidateToken,
        });
        if (reinviteError) throw new Error(reinviteError.message);
        const rotatedToken = (reinvited as Array<{ token: string }> | null)?.[0]?.token;

        if (rotatedToken) {
          // The RPC rotated the row — re-invite a previously-removed member. accept_cohort_invite's
          // ON CONFLICT ... DO UPDATE SET status = 'active' reactivates the membership end-to-end
          // when they click this (new) link again.
          const link = `${args.origin}/invite/${rotatedToken}`;
          const { subject, htmlBody, textBody } = inviteEmail(args.sponsorName, link);
          await sendOrRecordFailure(email, subject, htmlBody, textBody);
          resent.push(email);
          continue;
        }

        // Accepted AND the member is still active (or no reactivatable membership was found at all)
        // — skip exactly as before.
        skipped.push(email);
        continue;
      }
      throw new Error(error.message);
    }

    const invite: CohortInvite = {
      id: data!.id as string,
      sponsorId: data!.sponsor_id as string,
      email: data!.email as string,
      token: data!.token as string,
      acceptedAt: (data!.accepted_at as string | null) ?? null,
      createdAt: data!.created_at as string,
    };
    invited.push(invite);

    const link = `${args.origin}/invite/${invite.token}`;
    const { subject, htmlBody, textBody } = inviteEmail(args.sponsorName, link);
    await sendOrRecordFailure(invite.email, subject, htmlBody, textBody);
  }

  return { invited, skipped, resent, failed };
}
