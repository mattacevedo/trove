// Static alias table: maps common raw skill strings to a seeded O*NET canonical_name.
// Hand-curated for the pilot domain; grows deliberately (never auto-inflated by the LLM).
// The `canonicalName` values MUST match a seeded skills.canonical_name exactly.
// Do NOT list an `alias` that is itself a seeded canonical name (e.g. "Python",
// "JavaScript" are seeded competencies) — the exact tier resolves those first, making
// any such alias unreachable. See the precedence note above.
export interface AliasEntry {
  alias: string;
  canonicalName: string;
}

export const SKILL_ALIASES: readonly AliasEntry[] = [
  { alias: "Coding", canonicalName: "Programming" },
  { alias: "Public Speaking", canonicalName: "Speaking" },
  { alias: "Customer Service", canonicalName: "Service Orientation" },
  { alias: "Problem Solving", canonicalName: "Critical Thinking" },
  { alias: "Time Management", canonicalName: "Time Management" },
  { alias: "Teamwork", canonicalName: "Coordination" },
  { alias: "Active Listening", canonicalName: "Active Listening" },
];
