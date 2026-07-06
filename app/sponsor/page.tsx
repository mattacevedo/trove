import { requireSponsorAdmin } from "@/lib/auth/require-sponsor-admin";
import { getSponsorEngagement } from "@/lib/billing/engagement";
import { createServerClient } from "@/lib/supabase/server";
import { StatCard } from "@/components/sponsor/StatCard";
import { MemberTable, type MemberRow } from "@/components/sponsor/MemberTable";

interface CohortMemberJoin {
  status: string;
  consent_share_skills: boolean;
  consent_share_credentials: boolean;
  invited_at: string;
  earners: { handle: string | null } | { handle: string | null }[] | null;
}

export default async function SponsorPage() {
  const { sponsorId } = await requireSponsorAdmin();
  const supabase = await createServerClient();

  const [metrics, membersResult] = await Promise.all([
    getSponsorEngagement(supabase, sponsorId),
    // RLS (cohort_members_sponsor_select) scopes this to the admin's own cohort.
    // We read ONLY membership + consent flags + the earner's public handle —
    // never credentials or skills.
    supabase
      .from("cohort_members")
      .select(
        "status, consent_share_skills, consent_share_credentials, invited_at, earners(handle)"
      )
      .eq("sponsor_id", sponsorId)
      .order("invited_at", { ascending: false }),
  ]);

  const memberData = (membersResult.data ?? []) as unknown as CohortMemberJoin[];
  const rows: MemberRow[] = memberData.map((m) => {
    // Supabase types the embedded relation as an array or a single object depending on how the
    // FK is inferred — normalize both shapes here rather than trusting either at the type level.
    const earner = Array.isArray(m.earners) ? m.earners[0] ?? null : m.earners;
    return {
      handle: earner?.handle ?? null,
      status: m.status,
      consentSkills: m.consent_share_skills,
      consentCredentials: m.consent_share_credentials,
      joinedAt: m.invited_at,
    };
  });

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4">
      <header>
        <h1 className="font-heading text-xl font-semibold">Cohort engagement</h1>
        <p className="mt-1 text-sm text-foreground/70">
          Aggregate funnel across your cohort. You only see what members have consented to share.
        </p>
      </header>

      <section aria-label="Engagement funnel" className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Invited" value={metrics.invited} hint="total invites sent" />
        <StatCard label="Activated" value={metrics.activated} hint="joined the wallet" />
        <StatCard label="Imported" value={metrics.imported} hint="added a credential" />
        <StatCard label="Advisor used" value={metrics.advisorUsed} hint="tried the AI advisor" />
      </section>

      <section aria-label="Members">
        <h2 className="mb-2 font-heading text-base font-semibold">Members</h2>
        <MemberTable rows={rows} />
      </section>
    </div>
  );
}
