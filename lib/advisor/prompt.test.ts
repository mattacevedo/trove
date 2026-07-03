import { expect, test } from "vitest";
import { SYSTEM_PROMPT, buildContextBlock } from "./prompt";
import type { AdvisorContext } from "@/lib/advisor/types";

const base: AdvisorContext = {
  verifiedCredentials: [{ title: "RN License", issuerName: "State Board" }],
  unverifiedCredentials: [{ title: "CPR Cert", issuerName: "Self-reported" }],
  earnerSkillNames: ["Reading", "Writing"],
  targetOccupationName: "Nurse",
  targetGap: {
    occupationId: "A",
    occupationName: "Nurse",
    haveSkillIds: ["s1"],
    missingSkillNames: ["Critical Thinking"],
    haveCount: 1,
    totalCount: 3,
    coveragePct: 33,
  },
  candidateGaps: [],
  history: [],
  hasUnverifiedCredentials: true,
};

test("SYSTEM_PROMPT carries the guidance-not-guarantee and flag-unverified framing", () => {
  expect(SYSTEM_PROMPT).toMatch(/guidance, not a guarantee/i);
  expect(SYSTEM_PROMPT).toMatch(/unverified/i);
});

test("context block labels verified vs unverified and shows the pre-computed gap", () => {
  const block = buildContextBlock(base);
  expect(block).toMatch(/Verified credentials:\n- RN License/);
  expect(block).toMatch(/Unverified credentials:\n- CPR Cert/);
  expect(block).toMatch(/you have 1 of 3 required skills \(33%\)/);
  expect(block).toMatch(/Missing: Critical Thinking/);
});

test("omits the gap line and shows candidates when no target is set", () => {
  const block = buildContextBlock({
    ...base,
    targetOccupationName: null,
    targetGap: null,
    candidateGaps: [
      {
        occupationId: "B",
        occupationName: "Analyst",
        haveSkillIds: [],
        missingSkillNames: [],
        haveCount: 2,
        totalCount: 5,
        coveragePct: 40,
      },
    ],
  });
  expect(block).toMatch(/Target occupation: not set/);
  expect(block).toMatch(/Candidate occupations/);
  expect(block).toMatch(/Analyst: 2 of 5 \(40%\)/);
});

test("never leaks raw_json (context block has no raw_json key)", () => {
  expect(buildContextBlock(base)).not.toMatch(/raw_json/);
});
