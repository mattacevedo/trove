import { requireSponsorAdmin } from "@/lib/auth/require-sponsor-admin";
import { createServerClient } from "@/lib/supabase/server";
import { getSponsorSkillCoverage } from "@/lib/billing/skill-coverage";
import { CoverageBars } from "@/components/sponsor/CoverageBars";

export default async function SkillsPage() {
  const { sponsorId } = await requireSponsorAdmin();
  const db = await createServerClient();
  const rows = await getSponsorSkillCoverage(db, sponsorId);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Skill coverage</h1>
      <p className="mt-1 text-sm text-gray-600">
        Aggregate skills across cohort members who opted in to share. Individual
        members are never identified here.
      </p>
      <div className="mt-6">
        <CoverageBars rows={rows} />
      </div>
    </main>
  );
}
