import { expect, test } from "vitest";
import { rollUpEarnerSkills } from "./rollup";
import type { NormalizedSkillMatch } from "@/lib/skills/types";

function match(skillId: string | null, confidence: number): NormalizedSkillMatch {
  return {
    candidate: "x",
    skillId,
    confidence,
    method: skillId ? "exact" : "unmatched",
  };
}

test("aggregates the same skill across credentials: count + max confidence", () => {
  const out = rollUpEarnerSkills([
    [match("s1", 0.6)],
    [match("s1", 0.9)],
  ]);
  expect(out).toEqual([{ skillId: "s1", sourceCount: 2, highestConfidence: 0.9 }]);
});

test("drops unmatched (null skillId) matches", () => {
  const out = rollUpEarnerSkills([[match(null, 0), match("s2", 0.8)]]);
  expect(out).toEqual([{ skillId: "s2", sourceCount: 1, highestConfidence: 0.8 }]);
});

test("counts a skill once per credential even if it appears twice within one credential", () => {
  const out = rollUpEarnerSkills([[match("s1", 0.5), match("s1", 0.7)]]);
  expect(out).toEqual([{ skillId: "s1", sourceCount: 1, highestConfidence: 0.7 }]);
});

test("empty input yields empty output; output is ordered by skillId", () => {
  expect(rollUpEarnerSkills([])).toEqual([]);
  const out = rollUpEarnerSkills([[match("s2", 0.5)], [match("s1", 0.5)]]);
  expect(out.map((r) => r.skillId)).toEqual(["s1", "s2"]);
});
