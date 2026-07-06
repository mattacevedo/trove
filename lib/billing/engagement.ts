// Sponsor engagement funnel — thin, SDK-free mapping over the sponsor_engagement RPC (Task 1).
// The RPC is SECURITY DEFINER and guards on is_sponsor_admin(target_sponsor), so authorization
// lives in Postgres; this layer only shapes the aggregate row into the canonical EngagementMetrics
// that the dashboard (Task 8) renders verbatim. Aggregate-only: no individual member row is ever
// returned, preserving the "consented/aggregate only, never silent surveillance" invariant.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EngagementMetrics } from "@/lib/billing/types";

interface EngagementRpcRow {
  invited: number;
  activated: number;
  imported: number;
  advisor_used: number;
}

export async function getSponsorEngagement(
  db: SupabaseClient,
  sponsorId: string
): Promise<EngagementMetrics> {
  const { data, error } = await db.rpc("sponsor_engagement", { target_sponsor: sponsorId });
  if (error) throw error;

  // A set-returning RPC comes back as an array of rows; sponsor_engagement returns exactly one.
  // If it yields no row (unexpected for an authorized admin), fall back to zeros rather than NaN.
  const row = (Array.isArray(data) ? data[0] : data) as EngagementRpcRow | undefined | null;
  if (!row) return { invited: 0, activated: 0, imported: 0, advisorUsed: 0 };

  return {
    invited: row.invited ?? 0,
    activated: row.activated ?? 0,
    imported: row.imported ?? 0,
    advisorUsed: row.advisor_used ?? 0,
  };
}
