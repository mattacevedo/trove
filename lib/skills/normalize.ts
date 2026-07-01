import type {
  CanonicalSkill,
  NormalizedSkillMatch,
  RawSkillMention,
} from "@/lib/skills/types";
import { SKILL_ALIASES } from "@/lib/skills/aliases";

export const DEFAULT_TRIGRAM_THRESHOLD = 0.35;
export const TRIGRAM_CONFIDENCE_CAP = 0.9;
const ALIAS_CONFIDENCE = 0.95;

/** Lowercase, trim, collapse internal whitespace, strip surrounding punctuation. */
function normalizeString(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const grams = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) grams.add(padded.slice(i, i + 3));
  return grams;
}

/** Dice-coefficient similarity over character trigrams; approximates pg_trgm for tests. */
export function trigramSimilarity(a: string, b: string): number {
  const ga = trigrams(normalizeString(a));
  const gb = trigrams(normalizeString(b));
  if (ga.size === 0 || gb.size === 0) return 0;
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  return (2 * shared) / (ga.size + gb.size);
}

export function normalizeSkills(
  mentions: RawSkillMention[],
  vocabulary: CanonicalSkill[],
  opts?: {
    trigramThreshold?: number;
    trigramScorer?: (a: string, b: string) => number;
  }
): NormalizedSkillMatch[] {
  const threshold = opts?.trigramThreshold ?? DEFAULT_TRIGRAM_THRESHOLD;
  const scorer = opts?.trigramScorer ?? trigramSimilarity;

  // Build lookup maps once.
  const byExact = new Map<string, CanonicalSkill>();
  const byAlias = new Map<string, CanonicalSkill>();
  const byName = new Map<string, CanonicalSkill>();
  for (const v of vocabulary) {
    byExact.set(normalizeString(v.canonical_name), v);
    byName.set(v.canonical_name, v);
    for (const a of v.aliases) byAlias.set(normalizeString(a), v);
  }
  // Static alias table (canonicalName -> vocab row, if that row is seeded).
  for (const { alias, canonicalName } of SKILL_ALIASES) {
    const target = byName.get(canonicalName);
    if (target) byAlias.set(normalizeString(alias), target);
  }

  return mentions.map((mention) => {
    const key = normalizeString(mention.rawName);

    const exact = byExact.get(key);
    if (exact) {
      return { candidate: mention.rawName, skillId: exact.id, confidence: 1.0, method: "exact" };
    }

    const alias = byAlias.get(key);
    if (alias) {
      return {
        candidate: mention.rawName,
        skillId: alias.id,
        confidence: ALIAS_CONFIDENCE,
        method: "alias",
      };
    }

    // Tier 2: trigram — best single match at/above threshold.
    let best: { skill: CanonicalSkill; score: number } | null = null;
    for (const v of vocabulary) {
      const score = scorer(mention.rawName, v.canonical_name);
      if (!best || score > best.score) best = { skill: v, score };
    }
    if (best && best.score >= threshold) {
      return {
        candidate: mention.rawName,
        skillId: best.skill.id,
        confidence: Math.min(best.score, TRIGRAM_CONFIDENCE_CAP),
        method: "trigram",
      };
    }

    return { candidate: mention.rawName, skillId: null, confidence: 0, method: "unmatched" };
  });
}
