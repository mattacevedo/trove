import { requireSponsorAdmin } from "@/lib/auth/require-sponsor-admin";
import { createServerClient } from "@/lib/supabase/server";
import { CohortInviteForm } from "@/components/sponsor/cohort-invite-form";
import { CohortRosterTable, type CohortRosterRow } from "@/components/sponsor/cohort-roster-table";

export default async function CohortPage() {
  const { sponsorId } = await requireSponsorAdmin();
  const supabase = await createServerClient();

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
