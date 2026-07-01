import { expect, test, vi } from "vitest";
import { extractStructured, extractSkills, type ExtractDeps } from "./extract";
import type { LlmClient, RawSkillMention, StoredCredential } from "@/lib/skills/types";

function fakeLlm(mentions: RawSkillMention[]): LlmClient {
  return { extractSkills: vi.fn(async () => mentions) };
}
function throwingLlm(): LlmClient {
  return {
    extractSkills: vi.fn(async () => {
      throw new Error("LLM must not be called when structured data exists");
    }),
  };
}

test("OB2.x BadgeClass alignment maps to structured mentions at confidence 1.0", () => {
  const raw = {
    type: "BadgeClass",
    alignment: [
      { targetName: "Python Programming", targetUrl: "https://x/py", targetFramework: "O*NET" },
    ],
  };
  expect(extractStructured(raw)).toEqual([
    {
      rawName: "Python Programming",
      type: "skill",
      confidence: 1.0,
      source: "structured",
      externalId: "https://x/py",
      framework: "O*NET",
    },
  ]);
});

test("OB2.x Assertion nests alignment under badge", () => {
  const raw = {
    type: "Assertion",
    badge: { alignment: [{ targetName: "Welding", targetUrl: "https://x/w" }] },
  };
  const out = extractStructured(raw);
  expect(out).toHaveLength(1);
  expect(out[0].rawName).toBe("Welding");
  expect(out[0].framework).toBeUndefined();
});

test("OB3.0 credentialSubject.achievement.alignment maps through", () => {
  const raw = {
    credentialSubject: {
      achievement: {
        alignment: [{ targetName: "Critical Thinking", targetUrl: "https://x/ct" }],
      },
    },
  };
  const out = extractStructured(raw);
  expect(out).toEqual([
    {
      rawName: "Critical Thinking",
      type: "skill",
      confidence: 1.0,
      source: "structured",
      externalId: "https://x/ct",
      framework: undefined,
    },
  ]);
});

test("CLR: achievement array yields a mention per entry; CFItem targetType is competency", () => {
  const raw = {
    credentialSubject: {
      achievement: [
        { alignment: [{ targetName: "Skill A", targetUrl: "https://x/a" }] },
        {
          alignment: [
            { targetName: "Competency B", targetUrl: "https://x/b", targetType: "CFItem" },
          ],
        },
      ],
    },
  };
  const out = extractStructured(raw);
  expect(out).toHaveLength(2);
  expect(out[0]).toMatchObject({ rawName: "Skill A", type: "skill" });
  expect(out[1]).toMatchObject({ rawName: "Competency B", type: "competency" });
});

test("generic VC credentialSubject.skills array maps at confidence 0.9", () => {
  const raw = { credentialSubject: { skills: ["Customer Service", "Scheduling"] } };
  const out = extractStructured(raw);
  expect(out).toHaveLength(2);
  expect(out[0]).toEqual({
    rawName: "Customer Service",
    type: "skill",
    confidence: 0.9,
    source: "structured",
  });
});

test("null or unrecognized raw_json returns no mentions", () => {
  expect(extractStructured(null)).toEqual([]);
  expect(extractStructured({ foo: "bar" })).toEqual([]);
  expect(extractStructured("not an object")).toEqual([]);
});

test("extractSkills short-circuits and never calls the LLM when structured data exists", async () => {
  const deps: ExtractDeps = { llm: throwingLlm() };
  const credential: StoredCredential = {
    id: "c1",
    title: "Badge",
    description: "desc",
    raw_json: { type: "BadgeClass", alignment: [{ targetName: "SQL", targetUrl: "https://x/sql" }] },
  };
  const result = await extractSkills(credential, deps);
  expect(result.method).toBe("structured");
  expect(result.mentions.map((m) => m.rawName)).toEqual(["SQL"]);
  expect(deps.llm.extractSkills).not.toHaveBeenCalled();
});

test("extractSkills falls back to the LLM once and clamps confidence to <= 0.7", async () => {
  const deps: ExtractDeps = {
    llm: fakeLlm([
      { rawName: "Leadership", type: "skill", confidence: 0.95, source: "llm" },
    ]),
  };
  const credential: StoredCredential = {
    id: "c2",
    title: "Team Lead Certificate",
    description: "Led a team.",
    raw_json: null,
  };
  const result = await extractSkills(credential, deps);
  expect(result.method).toBe("llm");
  expect(deps.llm.extractSkills).toHaveBeenCalledTimes(1);
  expect(result.mentions[0].source).toBe("llm");
  expect(result.mentions[0].confidence).toBeLessThanOrEqual(0.7);
});

test("extractSkills returns method 'none' with no text and no structured data", async () => {
  const deps: ExtractDeps = { llm: throwingLlm() };
  const credential: StoredCredential = { id: "c3", title: "", description: "", raw_json: null };
  const result = await extractSkills(credential, deps);
  expect(result).toEqual({ mentions: [], method: "none" });
  expect(deps.llm.extractSkills).not.toHaveBeenCalled();
});
