import { expect, test } from "vitest";
import {
  normalizeSkills,
  trigramSimilarity,
  DEFAULT_TRIGRAM_THRESHOLD,
  TRIGRAM_CONFIDENCE_CAP,
} from "./normalize";
import type { CanonicalSkill, RawSkillMention } from "@/lib/skills/types";

const vocab: CanonicalSkill[] = [
  { id: "s1", canonical_name: "Project Management", type: "skill", onet_id: "x1", aliases: [] },
  {
    id: "s2",
    canonical_name: "Programming",
    type: "skill",
    onet_id: "x2",
    aliases: ["JS", "JavaScript", "Python"],
  },
  { id: "s3", canonical_name: "Critical Thinking", type: "skill", onet_id: "x3", aliases: [] },
];

function m(rawName: string): RawSkillMention {
  return { rawName, type: "skill", confidence: 1.0, source: "structured" };
}

test("exact match is case/whitespace-insensitive at confidence 1.0", () => {
  const out = normalizeSkills([m("  project   MANAGEMENT ")], vocab);
  expect(out[0]).toEqual({
    candidate: "  project   MANAGEMENT ",
    skillId: "s1",
    confidence: 1.0,
    method: "exact",
  });
});

test("alias match resolves to the canonical skill at confidence 0.95", () => {
  const out = normalizeSkills([m("JS")], vocab);
  expect(out[0]).toMatchObject({ skillId: "s2", confidence: 0.95, method: "alias" });
});

test("trigram match above threshold uses an injected scorer, capped at 0.9", () => {
  const scorer = (a: string, b: string) =>
    b.toLowerCase() === "project management" ? 1.0 : 0.0;
  const out = normalizeSkills([m("projet managment")], vocab, { trigramScorer: scorer });
  expect(out[0]).toMatchObject({ skillId: "s1", method: "trigram" });
  expect(out[0].confidence).toBeLessThanOrEqual(TRIGRAM_CONFIDENCE_CAP);
  expect(out[0].confidence).toBeCloseTo(TRIGRAM_CONFIDENCE_CAP);
});

test("trigram below threshold is unmatched", () => {
  const scorer = () => 0.1;
  const out = normalizeSkills([m("something unrelated")], vocab, { trigramScorer: scorer });
  expect(out[0]).toEqual({
    candidate: "something unrelated",
    skillId: null,
    confidence: 0,
    method: "unmatched",
  });
});

test("exact wins over a perfect trigram score (never outranked)", () => {
  const scorer = () => 1.0;
  const out = normalizeSkills([m("Critical Thinking")], vocab, { trigramScorer: scorer });
  expect(out[0]).toMatchObject({ skillId: "s3", confidence: 1.0, method: "exact" });
});

test("empty candidates yields empty result; empty vocab yields all unmatched", () => {
  expect(normalizeSkills([], vocab)).toEqual([]);
  const out = normalizeSkills([m("Anything")], []);
  expect(out[0].method).toBe("unmatched");
});

test("the built-in trigram scorer scores near-identical strings high and disjoint strings low", () => {
  expect(trigramSimilarity("project management", "projct management")).toBeGreaterThan(
    DEFAULT_TRIGRAM_THRESHOLD
  );
  expect(trigramSimilarity("welding", "accounting")).toBeLessThan(DEFAULT_TRIGRAM_THRESHOLD);
});
