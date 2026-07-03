import { expect, test } from "vitest";
import { computeOccupationGaps, rankOccupationCandidates } from "./gaps";
import type {
  EarnerSkillRow,
  OccupationSkillRequirement,
} from "@/lib/advisor/types";

const earner: EarnerSkillRow[] = [
  { skillId: "s1", skillName: "Reading" },
  { skillId: "s2", skillName: "Writing" },
];

// Occupation A requires [s1,s2,s3]; B requires [s1,s4]; C requires [s5,s6] (no overlap).
const reqs: OccupationSkillRequirement[] = [
  { occupationId: "A", occupationName: "Nurse", skillId: "s1", importance: 4 },
  { occupationId: "A", occupationName: "Nurse", skillId: "s2", importance: 4 },
  { occupationId: "A", occupationName: "Nurse", skillId: "s3", importance: 3.5 },
  { occupationId: "B", occupationName: "Analyst", skillId: "s1", importance: 4 },
  { occupationId: "B", occupationName: "Analyst", skillId: "s4", importance: 3.5 },
  { occupationId: "C", occupationName: "Welder", skillId: "s5", importance: 4 },
  { occupationId: "C", occupationName: "Welder", skillId: "s6", importance: 4 },
];

test("computes have/missing/coveragePct per occupation", () => {
  const gaps = computeOccupationGaps(earner, reqs);
  const a = gaps.find((g) => g.occupationId === "A")!;
  const b = gaps.find((g) => g.occupationId === "B")!;
  expect(a.haveSkillIds).toEqual(["s1", "s2"]);
  expect(a.missingSkillNames).toEqual(["s3"]);
  expect(a.coveragePct).toBe(67); // 2/3 rounded
  expect(b.haveSkillIds).toEqual(["s1"]);
  expect(b.missingSkillNames).toEqual(["s4"]);
  expect(b.coveragePct).toBe(50);
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
  expect(c.missingSkillNames).toEqual(["s5", "s6"]);
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
  expect(a.missingSkillNames).toEqual(["s1", "s2", "s3"]);
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
