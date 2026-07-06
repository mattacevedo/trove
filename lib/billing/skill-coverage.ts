// Consented aggregate skill coverage for a sponsor. Thin mapping layer over the
// SECURITY DEFINER `sponsor_skill_coverage` RPC (Task 1), which itself enforces
// is_sponsor_admin + consent_share_skills=true and returns the top ~20 skills
// ordered by member_count desc. This module NEVER reads individual earner rows.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SkillCoverageRow } from "@/lib/billing/types";

interface CoverageRpcRow {
  skill_name: string;
  member_count: number;
}

export async function getSponsorSkillCoverage(
  db: SupabaseClient,
  sponsorId: string
): Promise<SkillCoverageRow[]> {
  const { data, error } = await db.rpc("sponsor_skill_coverage", {
    target_sponsor: sponsorId,
  });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as CoverageRpcRow[];
  return rows.map((r) => ({
    skillName: r.skill_name,
    memberCount: r.member_count,
  }));
}
