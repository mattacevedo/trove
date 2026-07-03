// Pure, deterministic skill-gap math — the "you have X of Y skills for occupation Z"
// computation the design doc (§6) mandates lives IN CODE, not the model. Zero I/O, zero tokens.
// Unit-testable with in-memory fixtures exactly like lib/skills/rollup.ts.

import type {
  EarnerSkillRow,
  OccupationGap,
  OccupationSkillRequirement,
} from "@/lib/advisor/types";

/**
 * Group requirement rows by occupation and diff against the earner's held skills.
 * Only returns occupations that have >= 1 requirement row (data-backed) AND >= minOverlap
 * skills already held (candidate filter — avoids surfacing occupations with near-zero signal).
 * Deterministic: output order is sorted by occupationId, independent of input order.
 */
export function computeOccupationGaps(
  earnerSkills: EarnerSkillRow[],
  requirements: OccupationSkillRequirement[],
  opts?: { minOverlap?: number }
): OccupationGap[] {
  const minOverlap = opts?.minOverlap ?? 1;
  const earnerSkillIds = new Set(earnerSkills.map((s) => s.skillId));

  // occupationId -> { name, skillId -> skillName (from requirement rows) }
  const byOccupation = new Map<
    string,
    { name: string; required: Map<string, string> }
  >();
  for (const req of requirements) {
    let entry = byOccupation.get(req.occupationId);
    if (!entry) {
      entry = { name: req.occupationName, required: new Map() };
      byOccupation.set(req.occupationId, entry);
    }
    entry.required.set(req.skillId, req.occupationName);
    // Skill display name lives on the requirement row's own name lookup below; we key the
    // missing-name list off a shared skill-name map assembled from requirements + earner rows.
  }

  // Build a skillId -> displayName map from both requirements (skillId) and earner rows.
  const skillNameById = new Map<string, string>();
  for (const s of earnerSkills) skillNameById.set(s.skillId, s.skillName);
  for (const req of requirements) {
    if (!skillNameById.has(req.skillId)) skillNameById.set(req.skillId, req.skillId);
  }

  const out: OccupationGap[] = [];
  for (const [occupationId, { name, required }] of byOccupation) {
    const totalCount = required.size;
    if (totalCount === 0) continue; // guard the coveragePct denominator

    const haveSkillIds: string[] = [];
    const missingSkillNames: string[] = [];
    for (const skillId of required.keys()) {
      if (earnerSkillIds.has(skillId)) haveSkillIds.push(skillId);
      else missingSkillNames.push(skillNameById.get(skillId) ?? skillId);
    }
    if (haveSkillIds.length < minOverlap) continue;

    out.push({
      occupationId,
      occupationName: name,
      haveSkillIds: haveSkillIds.sort(),
      missingSkillNames: missingSkillNames.sort(),
      haveCount: haveSkillIds.length,
      totalCount,
      coveragePct: Math.round((haveSkillIds.length / totalCount) * 100),
    });
  }

  return out.sort((a, b) =>
    a.occupationId < b.occupationId ? -1 : a.occupationId > b.occupationId ? 1 : 0
  );
}

/** Pick top-N candidates by coveragePct desc, ties broken by totalCount desc. Pure. */
export function rankOccupationCandidates(
  gaps: OccupationGap[],
  limit: number
): OccupationGap[] {
  return [...gaps]
    .sort((a, b) =>
      b.coveragePct !== a.coveragePct
        ? b.coveragePct - a.coveragePct
        : b.totalCount - a.totalCount
    )
    .slice(0, Math.max(0, limit));
}
