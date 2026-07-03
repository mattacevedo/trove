// Impure context assembly — the ONLY advisor module (besides cap.ts) that reads earner data from
// Supabase. Reuses getSkillVocabulary (Plan 2). Buckets credentials verified/unverified IN CODE
// from the credentials.verification_status enum, runs the pure gap math, and trims history.
// Never selects or forwards raw_json.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSkillVocabulary } from "@/lib/skills/data";
import {
  computeOccupationGaps,
  rankOccupationCandidates,
} from "@/lib/advisor/gaps";
import { trimHistory } from "@/lib/advisor/history";
import type {
  AdvisorContext,
  AdvisorTurn,
  EarnerSkillRow,
  OccupationGap,
  OccupationSkillRequirement,
} from "@/lib/advisor/types";

const CANDIDATE_LIMIT = 5;

export async function loadAdvisorContext(
  db: SupabaseClient,
  earnerId: string,
  threadId: string
): Promise<AdvisorContext> {
  // --- vocabulary (id -> {name, onet_id, type}) ---
  const vocabulary = await getSkillVocabulary(db);
  const skillNameById = new Map(vocabulary.map((s) => [s.id, s.canonical_name]));

  // --- earner skills (rolled up by Plan 2) ---
  const { data: esRows, error: esErr } = await db
    .from("earner_skills")
    .select("skill_id")
    .eq("earner_id", earnerId);
  if (esErr) throw esErr;
  const earnerSkills: EarnerSkillRow[] = (esRows ?? []).map((r) => ({
    skillId: r.skill_id as string,
    skillName: skillNameById.get(r.skill_id as string) ?? (r.skill_id as string),
  }));

  // --- credentials, bucketed verified/unverified IN CODE (failed excluded) ---
  const { data: credRows, error: credErr } = await db
    .from("credentials")
    .select("title, issuer_name, verification_status")
    .eq("earner_id", earnerId);
  if (credErr) throw credErr;
  const verifiedCredentials = [];
  const unverifiedCredentials = [];
  for (const c of credRows ?? []) {
    const entry = { title: (c.title as string) || "Untitled", issuerName: (c.issuer_name as string) || "Unknown issuer" };
    if (c.verification_status === "verified") verifiedCredentials.push(entry);
    else if (c.verification_status === "unverified") unverifiedCredentials.push(entry);
    // 'failed' credentials are excluded from context entirely.
  }

  // --- target occupation (durable, on earners) ---
  const { data: earnerRow, error: earnerErr } = await db
    .from("earners")
    .select("target_occupation_skill_id")
    .eq("id", earnerId)
    .single();
  if (earnerErr) throw earnerErr;
  const targetOccupationId = (earnerRow?.target_occupation_skill_id as string | null) ?? null;
  const targetOccupationName = targetOccupationId
    ? skillNameById.get(targetOccupationId) ?? null
    : null;

  // --- occupation_skills requirement rows (target-only if set, else candidate set) ---
  let osQuery = db
    .from("occupation_skills")
    .select("occupation_id, skill_id, importance");
  if (targetOccupationId) osQuery = osQuery.eq("occupation_id", targetOccupationId);
  const { data: osRows, error: osErr } = await osQuery.range(0, 9999);
  if (osErr) throw osErr;

  const requirements: OccupationSkillRequirement[] = (osRows ?? []).map((r) => ({
    occupationId: r.occupation_id as string,
    occupationName: skillNameById.get(r.occupation_id as string) ?? (r.occupation_id as string),
    skillId: r.skill_id as string,
    // Resolve the skill's canonical name here (the vocab map has it) so the gap math emits real
    // names, not UUIDs, into missingSkillNames. Fall back to the id only if the vocab lacks it.
    skillName: skillNameById.get(r.skill_id as string) ?? (r.skill_id as string),
    importance: r.importance as number,
  }));

  // When a target occupation is explicitly set, the earner chose it on purpose — a 0-of-N result
  // is itself the actionable answer, so compute its gap with minOverlap:0 (never filter it out).
  // For the no-target candidate-ranking path, keep the default minOverlap:1 so occupations with
  // zero current signal don't clutter the suggestions.
  let targetGap: OccupationGap | null = null;
  let candidateGaps: OccupationGap[] = [];
  if (targetOccupationId) {
    const gaps = computeOccupationGaps(earnerSkills, requirements, { minOverlap: 0 });
    targetGap = gaps.find((g) => g.occupationId === targetOccupationId) ?? null;
  } else {
    const gaps = computeOccupationGaps(earnerSkills, requirements);
    candidateGaps = rankOccupationCandidates(gaps, CANDIDATE_LIMIT);
  }

  // --- thread history (last turns, chronological, trimmed) ---
  const { data: msgRows, error: msgErr } = await db
    .from("advisor_messages")
    .select("role, content, created_at")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true });
  if (msgErr) throw msgErr;
  const history: AdvisorTurn[] = trimHistory(
    (msgRows ?? []).map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content as string,
    }))
  );

  return {
    verifiedCredentials,
    unverifiedCredentials,
    earnerSkillNames: earnerSkills.map((s) => s.skillName),
    targetOccupationName,
    targetGap,
    candidateGaps,
    history,
    hasUnverifiedCredentials: unverifiedCredentials.length > 0,
  };
}
