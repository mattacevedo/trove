import type { EarnerSkillRollup, NormalizedSkillMatch } from "@/lib/skills/types";

/**
 * Aggregate per-credential normalized matches into the earner_skills profile.
 * source_count counts credentials contributing the skill (deduped within a credential);
 * highest_confidence is the max across all contributing matches. Pure recompute — no
 * accumulation on prior state, so it correctly reflects credential deletions.
 */
export function rollUpEarnerSkills(
  matchesByCredential: NormalizedSkillMatch[][]
): EarnerSkillRollup[] {
  const agg = new Map<string, { sourceCount: number; highestConfidence: number }>();

  for (const credentialMatches of matchesByCredential) {
    // Collapse to one entry per skill within this credential first.
    const perCredential = new Map<string, number>();
    for (const match of credentialMatches) {
      if (match.skillId === null) continue;
      const prev = perCredential.get(match.skillId) ?? 0;
      perCredential.set(match.skillId, Math.max(prev, match.confidence));
    }
    for (const [skillId, confidence] of perCredential) {
      const entry = agg.get(skillId) ?? { sourceCount: 0, highestConfidence: 0 };
      entry.sourceCount += 1;
      entry.highestConfidence = Math.max(entry.highestConfidence, confidence);
      agg.set(skillId, entry);
    }
  }

  return Array.from(agg.entries())
    .map(([skillId, v]) => ({
      skillId,
      sourceCount: v.sourceCount,
      highestConfidence: v.highestConfidence,
    }))
    .sort((a, b) => (a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0));
}
