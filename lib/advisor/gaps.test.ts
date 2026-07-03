import { expect, test } from "vitest";
import { computeOccupationGaps, rankOccupationCandidates } from "./gaps";
import type {
  EarnerSkillRow,
  OccupationSkillRequirement,
} from "@/lib/advisor/types";

// Skill ids are opaque (UUID-like in production); skillName is the human-readable label. The gap
// math must emit NAMES (not ids) into missingSkillNames — these fixtures keep them distinct so a
// regression that leaks the id would fail an assertion instead of silently passing.
const NAME: Record<string, string> = {
  s1: "Reading",
  s2: "Writing",
  s3: "Clinical Judgment",
  s4: "Data Analysis",
  s5: "Welding",
  s6: "Blueprint Reading",
};
const earner: EarnerSkillRow[] = [
  { skillId: "s1", skillName: NAME.s1 },
  { skillId: "s2", skillName: NAME.s2 },
];

const req = (
  occupationId: string,
  occupationName: string,
  skillId: string,
  importance: number
): OccupationSkillRequirement => ({
  occupationId,
  occupationName,
  skillId,
  skillName: NAME[skillId],
  importance,
});

// Occupation A requires [s1,s2,s3]; B requires [s1,s4]; C requires [s5,s6] (no overlap).
const reqs: OccupationSkillRequirement[] = [
  req("A", "Nurse", "s1", 4),
  req("A", "Nurse", "s2", 4),
  req("A", "Nurse", "s3", 3.5),
  req("B", "Analyst", "s1", 4),
  req("B", "Analyst", "s4", 3.5),
  req("C", "Welder", "s5", 4),
  req("C", "Welder", "s6", 4),
];

test("computes have/missing/coveragePct per occupation, with missing skills as NAMES not ids", () => {
  const gaps = computeOccupationGaps(earner, reqs);
  const a = gaps.find((g) => g.occupationId === "A")!;
  const b = gaps.find((g) => g.occupationId === "B")!;
  expect(a.haveSkillIds).toEqual(["s1", "s2"]);
  expect(a.missingSkillNames).toEqual(["Clinical Judgment"]); // s3's name, never "s3"
  expect(a.coveragePct).toBe(67); // 2/3 rounded
  expect(b.haveSkillIds).toEqual(["s1"]);
  expect(b.missingSkillNames).toEqual(["Data Analysis"]); // s4's name
  expect(b.coveragePct).toBe(50);
});

test("missing-skill names resolve to canonical names even for UUID-shaped skill ids", () => {
  // Guards the regression where a MISSING skill (never in the earner's held set, so with no other
  // name source) fell back to its raw skills.id UUID in missingSkillNames.
  const uid = "6f1c2e7a-0000-4000-8000-000000000abc";
  const gaps = computeOccupationGaps(
    [{ skillId: "held-1", skillName: "Anatomy" }],
    [
      { occupationId: "occ-uuid", occupationName: "Registered Nurse", skillId: "held-1", skillName: "Anatomy", importance: 4 },
      { occupationId: "occ-uuid", occupationName: "Registered Nurse", skillId: uid, skillName: "Pharmacology", importance: 4 },
    ]
  );
  const g = gaps.find((x) => x.occupationId === "occ-uuid")!;
  expect(g.missingSkillNames).toEqual(["Pharmacology"]);
  expect(g.missingSkillNames).not.toContain(uid); // never the raw UUID
});

test("minOverlap default 1 excludes zero-overlap occupations; minOverlap 0 includes them", () => {
  const gaps = computeOccupationGaps(earner, reqs);
  expect(gaps.find((g) => g.occupationId === "C")).toBeUndefined();
  const all = computeOccupationGaps(earner, reqs, { minOverlap: 0 });
  expect(all.find((g) => g.occupationId === "C")).toBeDefined();
});

test("target with zero current overlap still yields a gap (0 of N) under minOverlap:0", () => {
  // The context loader uses minOverlap:0 for an explicitly-set target so the earner sees the
  // real "0 of N" answer instead of the gap silently disappearing (a stretch/target occupation).
  const gaps = computeOccupationGaps(earner, reqs, { minOverlap: 0 });
  const c = gaps.find((g) => g.occupationId === "C")!; // Welder: earner holds none of [s5,s6]
  expect(c.haveCount).toBe(0);
  expect(c.totalCount).toBe(2);
  expect(c.coveragePct).toBe(0);
  expect(c.missingSkillNames).toEqual(["Blueprint Reading", "Welding"]); // s6, s5 by name, sorted
});

test("empty requirements -> empty result (no divide-by-zero)", () => {
  expect(computeOccupationGaps(earner, [])).toEqual([]);
});

test("earner with zero skills -> every occupation is 0% coverage, all skills missing", () => {
  const gaps = computeOccupationGaps([], reqs, { minOverlap: 0 });
  expect(gaps).toHaveLength(3);
  for (const g of gaps) {
    expect(g.haveCount).toBe(0);
    expect(g.haveSkillIds).toEqual([]);
    expect(g.coveragePct).toBe(0);
  }
  const a = gaps.find((g) => g.occupationId === "A")!;
  expect(a.missingSkillNames).toEqual(["Clinical Judgment", "Reading", "Writing"]); // names, sorted
});

test("earner with zero skills and default minOverlap -> no occupations qualify", () => {
  expect(computeOccupationGaps([], reqs)).toEqual([]);
});

test("deterministic regardless of input order", () => {
  const shuffled = [...reqs].reverse();
  expect(computeOccupationGaps(earner, shuffled)).toEqual(
    computeOccupationGaps(earner, reqs)
  );
});

test("rankOccupationCandidates sorts by coveragePct desc then totalCount desc, respects limit", () => {
  const gaps = computeOccupationGaps(earner, reqs, { minOverlap: 0 });
  const ranked = rankOccupationCandidates(gaps, 2);
  expect(ranked).toHaveLength(2);
  // A=67% (2/3), B=50% (1/2), C=0% (0/2) -> sorted desc by coverage: [A, B, C], top 2 = [A, B]
  expect(ranked.map((g) => g.occupationId)).toEqual(["A", "B"]);
});
