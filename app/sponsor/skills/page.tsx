import { requireSponsorAdmin } from "@/lib/auth/require-sponsor-admin";
import { createServerClient } from "@/lib/supabase/server";
import { getSponsorSkillCoverage } from "@/lib/billing/skill-coverage";
import { CoverageBars } from "@/components/sponsor/CoverageBars";

export default async function SkillsPage() {
  const { sponsorId } = await requireSponsorAdmin();
  const db = await createServerClient();
  const rows = await getSponsorSkillCoverage(db, sponsorId);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4">
      <header>
        <h1 className="font-heading text-xl font-semibold">Skill coverage</h1>
        <p className="mt-1 text-sm text-foreground/70">
          Aggregate skills across cohort members who opted in to share. Individual
          members are never identified here.
        </p>
      </header>
      <section aria-label="Skill coverage">
        <CoverageBars rows={rows} />
      </section>
    </div>
  );
}
