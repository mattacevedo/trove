// IMPORTANT: this file is imported directly by the plain-Node .mjs seed script
// (scripts/seed-onet.mjs) via native type-stripping. Use ONLY relative imports and
// TYPE-ONLY `@/` imports here. A value `@/…` import would break the seed script because
// Node does not resolve tsconfig path aliases at runtime. The `import type` below is erased
// before resolution, so it is safe.
import type { SkillType } from "@/lib/skills/types";

export interface SeedRow {
  canonical_name: string;
  type: SkillType;
  onet_id: string | null;
}

/**
 * SOC major-group prefixes for the v1 subset: Management (11), Business/Financial (13),
 * Computer/Math (15), Healthcare Practitioners (29), Healthcare Support (31),
 * Protective Service (33), Construction (47), Installation/Maintenance/Repair (49),
 * Production (51).
 *
 * PROVISIONAL — NOT YET VALIDATED AGAINST PILOT DATA. Design doc §10 says the O*NET subset
 * scope should be "tied to the first pilot sponsor's population," but no pilot sponsor has
 * been onboarded yet, so this list is a best-guess placeholder for the workforce/TRIO
 * adult-learner populations we expect. TODO(pilot-onboarding): whoever onboards the first
 * real pilot sponsor MUST revisit this list against that sponsor's actual population and get
 * product sign-off before treating it as settled. Re-run scripts/seed-onet.mjs after any change.
 */
export const V1_OCCUPATION_PREFIXES: readonly string[] = [
  "11-",
  "13-",
  "15-",
  "29-",
  "31-",
  "33-",
  "47-",
  "49-",
  "51-",
];

/** Split a tab-delimited O*NET text file into a header list + typed row objects. */
function parseTable(text: string): Record<string, string>[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split("\t");
  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    const row: Record<string, string> = {};
    header.forEach((col, i) => {
      row[col] = (cells[i] ?? "").trim();
    });
    return row;
  });
}

export function parseOccupationData(
  text: string,
  allowlist: Set<string>
): SeedRow[] {
  const out: SeedRow[] = [];
  for (const row of parseTable(text)) {
    const code = row["O*NET-SOC Code"];
    const title = row["Title"];
    if (!code || !title || !allowlist.has(code)) continue;
    out.push({ canonical_name: title, type: "occupation", onet_id: code });
  }
  return out;
}

export function parseSkillsElements(text: string): SeedRow[] {
  const seen = new Set<string>();
  const out: SeedRow[] = [];
  for (const row of parseTable(text)) {
    const id = row["Element ID"];
    const name = row["Element Name"];
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({ canonical_name: name, type: "skill", onet_id: id });
  }
  return out;
}

export function parseTechnologySkills(
  text: string,
  allowlist: Set<string>
): SeedRow[] {
  const seen = new Set<string>();
  const out: SeedRow[] = [];
  for (const row of parseTable(text)) {
    const code = row["O*NET-SOC Code"];
    // O*NET 30.3 renamed Technology Skills.txt -> Software Skills.txt and its tool-name
    // column Example -> Workplace Example. Tolerate both known column names.
    const example = row["Example"] ?? row["Workplace Example"];
    const hot = row["Hot Technology"];
    if (!code || !example || hot !== "Y" || !allowlist.has(code)) continue;
    const name = example.trim();
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Technology Skills.txt has no stable per-tool ID; canonical_name is the natural key.
    out.push({ canonical_name: name, type: "competency", onet_id: null });
  }
  return out;
}
