// Shared types for the Trove AI advisor (Plan 5). This is the ONLY module every other
// lib/advisor/* file may import from. It imports nothing from the Supabase or Anthropic SDKs —
// keeping the pure core dependency-free and unit-testable. Mirrors lib/skills/types.ts.

/** A persisted advisor message row (subset used across the pipeline + UI). */
export interface AdvisorMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  tokenCost: number;
  createdAt: string;
}

/** A conversation turn passed to the LLM (no ids/costs — just role + content). */
export interface AdvisorTurn {
  role: "user" | "assistant";
  content: string;
}

export interface AdvisorThreadSummary {
  id: string;
  title: string;
  createdAt: string;
}

/** One occupation's required-skill row (already importance-filtered at seed time). */
export interface OccupationSkillRequirement {
  occupationId: string;
  occupationName: string;
  skillId: string;
  /** Canonical skill name, resolved from the skills vocabulary — NOT the raw UUID. The gap math
   *  emits this into `missingSkillNames`, so it must be human-readable or the "what to learn next"
   *  list shows UUIDs to the earner and the model. */
  skillName: string;
  importance: number;
}

/** The earner's rolled-up skill (from earner_skills). */
export interface EarnerSkillRow {
  skillId: string;
  skillName: string;
}

/** A credential surfaced to the advisor, pre-bucketed by verification status IN CODE. */
export interface AdvisorCredential {
  title: string;
  issuerName: string;
}

/** Pure gap-math output for one occupation. */
export interface OccupationGap {
  occupationId: string;
  occupationName: string;
  haveSkillIds: string[];
  missingSkillNames: string[];
  haveCount: number;
  totalCount: number;
  coveragePct: number; // 0..100, rounded
}

/** The full per-message context assembled in code and fed to the prompt builder. */
export interface AdvisorContext {
  verifiedCredentials: AdvisorCredential[];
  unverifiedCredentials: AdvisorCredential[];
  earnerSkillNames: string[];
  targetOccupationName: string | null;
  /** Gap for the target occupation, or ranked candidates when no target is set. */
  targetGap: OccupationGap | null;
  candidateGaps: OccupationGap[];
  history: AdvisorTurn[];
  /** True when at least one credential is unverified (advisor must flag reliance on it). */
  hasUnverifiedCredentials: boolean;
}

/** Injectable LLM boundary — real impl in lib/advisor/llm.ts, fake in tests. */
export interface AdvisorLlm {
  reply(input: {
    systemPrompt: string;
    contextBlock: string;
    history: AdvisorTurn[];
    userMessage: string;
    webSearchEnabled: boolean;
  }): Promise<{ content: string; tokenCost: number; usedWebSearch: boolean }>;
}

/**
 * One occupation card returned to the UI: the pure gap plus a conservative v1 unverified-reliance
 * flag. `reliesOnUnverified` is true when the earner has ANY unverified credential
 * (ctx.hasUnverifiedCredentials) — a deliberately conservative signal, since gaps.ts is
 * credential-status-agnostic and does not yet carry per-skill credential provenance. This makes
 * the amber "based partly on an unverified credential" flag on OccupationCard actually reachable
 * (design doc §6 mandates flagging reliance on unverified credentials at the action-guiding
 * surface, not only in prose).
 */
export interface OccupationCard {
  gap: OccupationGap;
  reliesOnUnverified: boolean;
}

/** The orchestrator's discriminated result. Never throws for cap/empty — returns a shaped value. */
export type RunAdvisorTurnResult =
  | { ok: true; message: AdvisorMessage; occupationCards: OccupationCard[] }
  | { ok: false; reason: "rate_limited"; retryAt: string }
  | { ok: false; reason: "empty_message" | "thread_not_found" };
