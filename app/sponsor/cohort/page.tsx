import { requireSponsorAdmin } from "@/lib/auth/require-sponsor-admin";
import { createServerClient } from "@/lib/supabase/server";
import { CohortInviteForm } from "@/components/sponsor/cohort-invite-form";
import { CohortRosterTable, type CohortRosterRow } from "@/components/sponsor/cohort-roster-table";

/** Human-readable copy for the cohort/removeMember actions' redirect error codes (app/sponsor/actions.ts). */
const ERROR_MESSAGES: Record<string, string> = {
  no_valid_emails: "No valid email addresses were found in what you entered. Check the formatting and try again.",
  missing_member: "No member was specified to remove.",
  remove_failed: "We couldn't remove that member. Please try again.",
};

export default async function CohortPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    invited?: string;
    skipped?: string;
    resent?: string;
    failed?: string;
  }>;
}) {
  const { sponsorId } = await requireSponsorAdmin();
  const { error, invited, skipped, resent, failed } = await searchParams;
  const supabase = await createServerClient();

  // CAUSE H: the inviteCohort action's redirect carries these counts so a successful send reports
  // exactly what happened, instead of a bare redirect. All four are present together (see
  // app/sponsor/actions.ts), so check just one to know a send just completed.
  const sendSummary =
    invited !== undefined
      ? {
          invited: Number(invited),
          skipped: Number(skipped ?? "0"),
          resent: Number(resent ?? "0"),
          failed: Number(failed ?? "0"),
        }
      : null;
  const errorMessage = error ? ERROR_MESSAGES[error] ?? "Something went wrong. Please try again." : null;

  // Members (accepted) and pending invites (not yet accepted). RLS: cohort_invites_sponsor_all and
  // cohort_members_sponsor_select scope both reads to this admin's sponsor automatically.
  const [{ data: invites }, { data: members }] = await Promise.all([
    supabase
      .from("cohort_invites")
      .select("email, accepted_at")
      .eq("sponsor_id", sponsorId)
      .is("accepted_at", null)
      .order("created_at", { ascending: false }),
    supabase
      .from("cohort_members")
      .select("earner_id, status, earners(handle)")
      .eq("sponsor_id", sponsorId)
      .eq("status", "active"),
  ]);

  const memberRows: CohortRosterRow[] = (members ?? []).map((m) => {
    const earner = m.earners as { handle: string | null } | { handle: string | null }[] | null;
    const handle = Array.isArray(earner) ? earner[0]?.handle ?? null : earner?.handle ?? null;
    return {
      email: handle ?? "(member)",
      status: m.status as string,
      accepted: true,
      earnerId: m.earner_id as string,
    };
  });
  const inviteRows: CohortRosterRow[] = (invites ?? []).map((i) => ({
    email: i.email as string,
    status: "invited",
    accepted: false,
  }));
  const rows = [...memberRows, ...inviteRows];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-4">
      <header>
        <h1 className="font-heading text-xl font-semibold">Invite your cohort</h1>
        <p className="mt-1 text-sm text-foreground/70">
          Invitees get a free Trove wallet and choose what to share back with you.
        </p>
      </header>

      {sendSummary ? (
        <p
          role="status"
          className="rounded-lg border border-foreground/15 bg-white p-4 text-sm text-foreground/80"
        >
          {sendSummary.invited} invited
          {sendSummary.resent > 0 ? `, ${sendSummary.resent} resent` : ""}
          {sendSummary.skipped > 0 ? `, ${sendSummary.skipped} already invited` : ""}
          {sendSummary.failed > 0 ? `, ${sendSummary.failed} failed to send` : ""}.
        </p>
      ) : null}
      {errorMessage ? (
        <p className="rounded-lg border border-foreground/15 bg-white p-4 text-sm" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <section aria-labelledby="invite-heading">
        <h2 id="invite-heading" className="sr-only">
          Send invitations
        </h2>
        <CohortInviteForm />
      </section>
      <section aria-labelledby="roster-heading">
        <h2 id="roster-heading" className="mb-3 font-heading text-lg font-semibold">
          Members &amp; pending invites
        </h2>
        <CohortRosterTable rows={rows} />
      </section>
    </div>
  );
}
