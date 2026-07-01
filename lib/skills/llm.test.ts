import { expect, test, vi } from "vitest";
import {
  createAnthropicLlmClient,
  InMemorySkillCache,
  cacheKey,
  clampMentions,
  type AnthropicLike,
} from "./llm";
import type { RawSkillMention } from "@/lib/skills/types";

// A fake Anthropic client returning a tool-use JSON block.
function fakeAnthropic(skills: Array<{ name: string; type: string }>): AnthropicLike {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [
          { type: "tool_use", name: "record_skills", input: { skills } },
        ],
      })),
    },
  };
}

test("clampMentions caps confidence at 0.7 and tags source llm", () => {
  const raw: RawSkillMention[] = [
    { rawName: "Leadership", type: "skill", confidence: 0.95, source: "structured" },
  ];
  expect(clampMentions(raw)).toEqual([
    { rawName: "Leadership", type: "skill", confidence: 0.7, source: "llm" },
  ]);
});

test("cacheKey is stable for identical text and differs for different text", () => {
  const a = cacheKey({ title: "T", description: "D" });
  const b = cacheKey({ title: "T", description: "D" });
  const c = cacheKey({ title: "T", description: "different" });
  expect(a).toBe(b);
  expect(a).not.toBe(c);
});

test("client checks cache before calling the model, and caches after a miss", async () => {
  const cache = new InMemorySkillCache();
  const anthropic = fakeAnthropic([{ name: "SQL", type: "skill" }]);
  const llm = createAnthropicLlmClient({ apiKey: "test", cache, client: anthropic });

  const first = await llm.extractSkills({ title: "DB Cert", description: "SQL work" });
  expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
  expect(first[0]).toMatchObject({ rawName: "SQL", source: "llm" });
  expect(first[0].confidence).toBeLessThanOrEqual(0.7);

  const second = await llm.extractSkills({ title: "DB Cert", description: "SQL work" });
  expect(anthropic.messages.create).toHaveBeenCalledTimes(1); // cache hit — no second call
  expect(second).toEqual(first);
});

test("the model payload contains only title/description text, never raw_json", async () => {
  const anthropic = fakeAnthropic([{ name: "X", type: "skill" }]);
  const llm = createAnthropicLlmClient({ apiKey: "test", cache: new InMemorySkillCache(), client: anthropic });
  await llm.extractSkills({ title: "Some Title", description: "Some Description" });
  const arg = (anthropic.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
  const serialized = JSON.stringify(arg);
  expect(serialized).toContain("Some Title");
  expect(serialized).toContain("Some Description");
  expect(serialized).not.toContain("raw_json");
  expect(arg.model).toBe("claude-sonnet-4-6");
});

test("unknown skill type from the model falls back to 'skill'", async () => {
  const anthropic = fakeAnthropic([{ name: "Y", type: "bogus" }]);
  const llm = createAnthropicLlmClient({ apiKey: "test", cache: new InMemorySkillCache(), client: anthropic });
  const out = await llm.extractSkills({ title: "t", description: "d" });
  expect(out[0].type).toBe("skill");
});
