// Pure prompt construction. The static SYSTEM_PROMPT never varies (a strong prompt-cache
// candidate). buildContextBlock formats the already-computed context struct — it NEVER asks the
// model to compute gaps and NEVER leaks raw_json. Safety framing (guidance-not-guarantee,
// flag-unverified) lives here per design doc §6.

import type { AdvisorContext } from "@/lib/advisor/types";

export const SYSTEM_PROMPT = [
  "You are Trove's career and education advisor. You help adult learners understand their",
  "skills, find occupations they may qualify for, identify what to learn next, and plan how to",
  "get there (admissions, financial aid, apprenticeships, certifications).",
  "",
  "Ground every claim in the earner's credential and skills data provided below. Never invent",
  "credentials, skills, jobs, programs, or outcomes not in the provided context.",
  "",
  'The context lists credentials in two groups: "Verified credentials" (independently confirmed)',
  'and "Unverified credentials" (self-reported, not independently confirmed). When your answer',
  "depends on something from the Unverified list, say so explicitly (for example: \"based on your",
  'self-reported X, which is not yet verified"). Do not treat unverified and verified credentials',
  "as equally certain.",
  "",
  "The context may include a pre-computed skill gap (\"you have X of Y skills for role Z\"). Use",
  "those numbers as given — do not recompute or second-guess them.",
  "",
  "Frame all outcomes as guidance, not a guarantee. Never state or imply that a job offer, program",
  'admission, or financial aid award is certain. Use language like "may qualify you for," "could be',
  'a strong fit," "is worth exploring" — not "will get you" or "guarantees."',
  "",
  "If you lack enough information (e.g. no gap data for an occupation), say so plainly instead of",
  "guessing.",
  "",
  "Only discuss career paths, occupations, skills, credentials, education, training, certifications,",
  "financial aid, and job-search strategy relevant to this earner. For anything else, politely",
  "decline and redirect.",
  "",
  "When citing time-sensitive or external facts (current openings, program deadlines), rely only on",
  "the search results provided and cite them; do not state such facts from memory.",
].join("\n");

export function buildContextBlock(ctx: AdvisorContext): string {
  const lines: string[] = [];

  lines.push("Verified credentials:");
  if (ctx.verifiedCredentials.length === 0) lines.push("- (none)");
  for (const c of ctx.verifiedCredentials) lines.push(`- ${c.title} (${c.issuerName})`);

  lines.push("", "Unverified credentials:");
  if (ctx.unverifiedCredentials.length === 0) lines.push("- (none)");
  for (const c of ctx.unverifiedCredentials) lines.push(`- ${c.title} (${c.issuerName})`);

  lines.push("", "Skills profile:");
  if (ctx.earnerSkillNames.length === 0) lines.push("- (none yet)");
  for (const name of ctx.earnerSkillNames) lines.push(`- ${name}`);

  lines.push("", `Target occupation: ${ctx.targetOccupationName ?? "not set"}`);

  if (ctx.targetGap) {
    const g = ctx.targetGap;
    lines.push(
      `Skill gap for ${g.occupationName}: you have ${g.haveCount} of ${g.totalCount} ` +
        `required skills (${g.coveragePct}%).` +
        (g.missingSkillNames.length
          ? ` Missing: ${g.missingSkillNames.join(", ")}.`
          : "")
    );
  } else if (!ctx.targetOccupationName && ctx.candidateGaps.length > 0) {
    lines.push("Candidate occupations by current skill coverage:");
    for (const g of ctx.candidateGaps) {
      lines.push(`- ${g.occupationName}: ${g.haveCount} of ${g.totalCount} (${g.coveragePct}%)`);
    }
  } else if (ctx.targetOccupationName) {
    // A target is set but computeOccupationGaps(minOverlap:0) returned no gap for it — i.e. the
    // occupation genuinely has no seeded requirement rows. Distinct from the no-target case so a
    // debugger can tell "unseeded occupation" apart from "no target chosen".
    lines.push(
      `Skill-gap data has not been seeded for ${ctx.targetOccupationName} yet, so an exact ` +
        `"X of Y skills" count is not available.`
    );
  } else {
    lines.push("No target occupation is set and no candidate occupations could be ranked yet.");
  }

  return lines.join("\n");
}
