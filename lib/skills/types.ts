// Shared types for the Trove skills engine. This is the ONLY module every other
// lib/skills/* file may import from. It imports nothing from the Supabase or
// Anthropic SDKs — keeping the pure core dependency-free and unit-testable.

export type SkillType = "skill" | "competency" | "occupation";
export type SkillSource = "structured" | "llm";

/** One candidate skill mention pulled out of a credential (before normalization). */
export interface RawSkillMention {
  rawName: string;
  type: SkillType;
  confidence: number; // 0..1
  source: SkillSource;
  externalId?: string; // e.g. OB alignment targetUrl
  framework?: string; // e.g. OB alignment targetFramework
}

/** The subset of a `credentials` row the extractor needs. */
export interface StoredCredential {
  id: string;
  title: string;
  description: string; // "" when the credential has no description
  raw_json: unknown | null;
}

export type ExtractMethod = "structured" | "llm" | "none";
export interface ExtractResult {
  mentions: RawSkillMention[];
  method: ExtractMethod;
}

/** A canonical vocabulary row (from the seeded `skills` table). */
export interface CanonicalSkill {
  id: string;
  canonical_name: string;
  type: SkillType;
  onet_id: string | null;
  aliases: string[]; // pre-joined alias strings; may be empty
}

export type MatchMethod = "exact" | "alias" | "trigram" | "unmatched";
export interface NormalizedSkillMatch {
  candidate: string; // the rawName that was matched
  skillId: string | null; // null when unmatched
  confidence: number; // 0 when unmatched
  method: MatchMethod;
}

/** The aggregate written to `earner_skills`. */
export interface EarnerSkillRollup {
  skillId: string;
  sourceCount: number;
  highestConfidence: number;
}

/** Injectable LLM boundary — real impl in lib/skills/llm.ts, fake in tests. */
export interface LlmClient {
  extractSkills(input: {
    title: string;
    description: string;
  }): Promise<RawSkillMention[]>;
}

/** Content-hash cache boundary for LLM results. */
export interface SkillExtractionCache {
  get(key: string): Promise<RawSkillMention[] | null>;
  set(key: string, value: RawSkillMention[]): Promise<void>;
}
