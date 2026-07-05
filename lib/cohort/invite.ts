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

function inviteEmail(sponsorName: string, link: string): { subject: string; htmlBody: string; textBody: string } {
  const subject = `${sponsorName} invited you to Trove`;
  const textBody =
    `${sponsorName} invited you to join their cohort on Trove — your free, standards-based ` +
    `credential wallet.\n\nAccept your invitation:\n${link}\n\n` +
    `You control what you share. Sponsors only see data you explicitly consent to.`;
  const htmlBody =
    `<p>${sponsorName} invited you to join their cohort on <strong>Trove</strong> — ` +
    `your free, standards-based credential wallet.</p>` +
    `<p><a href="${link}">Accept your invitation</a></p>` +
    `<p>You control what you share. Sponsors only see data you explicitly consent to.</p>`;
  return { subject, htmlBody, textBody };
}

export async function inviteCohort(
  db: SupabaseClient,
  sender: EmailSender,
  args: { sponsorId: string; sponsorName: string; emails: string[]; origin: string }
): Promise<{ invited: CohortInvite[]; skipped: string[] }> {
  const invited: CohortInvite[] = [];
  const skipped: string[] = [];

  for (const email of args.emails) {
    const token = generateInviteToken();
    const { data, error } = await db
      .from("cohort_invites")
      .insert({ sponsor_id: args.sponsorId, email, token })
      .select("id, sponsor_id, email, token, accepted_at, created_at")
      .single();

    if (error) {
      // 23505 = unique_violation on unique(sponsor_id, email) => already invited: skip quietly.
      if (error.code === "23505") {
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
    await sender.send({ to: invite.email, subject, htmlBody, textBody });
  }

  return { invited, skipped };
}
