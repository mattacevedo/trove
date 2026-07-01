import { afterAll, expect, test, vi } from "vitest";
import { adminClient } from "@/tests/db/admin-client";
import { processCredential } from "./index";
import { getSkillVocabulary } from "@/lib/skills/data";
import type { LlmClient } from "@/lib/skills/types";

const admin = adminClient();
const created: string[] = [];

afterAll(async () => {
  for (const id of created) await admin.auth.admin.deleteUser(id);
});

test("processCredential: structured credential resolves skills without calling the LLM", async () => {
  // Pick a real seeded skill to align to, so normalize produces an exact match.
  const vocab = await getSkillVocabulary(admin);
  const target = vocab.find((v) => v.type === "skill");
  expect(target).toBeDefined();

  const email = `idx-${Date.now()}@example.com`;
  const { data: u } = await admin.auth.admin.createUser({ email, email_confirm: true });
  const earnerId = u!.user!.id;
  created.push(earnerId);
  await admin.from("earners").insert({ id: earnerId, handle: `idx${Date.now()}` });

  const { data: cred } = await admin
    .from("credentials")
    .insert({
      earner_id: earnerId,
      source: "ob_url",
      title: "Aligned Badge",
      raw_json: {
        type: "BadgeClass",
        alignment: [{ targetName: target!.canonical_name, targetUrl: "https://x/a" }],
      },
    })
    .select("id")
    .single();

  const throwingLlm: LlmClient = {
    extractSkills: vi.fn(async () => {
      throw new Error("LLM must not be called for structured credentials");
    }),
  };

  const { skillCount } = await processCredential(admin, throwingLlm, cred!.id as string);
  expect(skillCount).toBe(1);
  expect(throwingLlm.extractSkills).not.toHaveBeenCalled();

  const { data: es } = await admin
    .from("earner_skills")
    .select("skill_id")
    .eq("earner_id", earnerId);
  expect(es![0].skill_id).toBe(target!.id);
});

test("processCredential: text-only credential uses the injected fake LLM", async () => {
  const vocab = await getSkillVocabulary(admin);
  const target = vocab.find((v) => v.type === "skill");

  const email = `idx2-${Date.now()}@example.com`;
  const { data: u } = await admin.auth.admin.createUser({ email, email_confirm: true });
  const earnerId = u!.user!.id;
  created.push(earnerId);
  await admin.from("earners").insert({ id: earnerId, handle: `idx2${Date.now()}` });

  const { data: cred } = await admin
    .from("credentials")
    .insert({ earner_id: earnerId, source: "manual", title: "Paper Certificate", raw_json: null })
    .select("id")
    .single();

  const fakeLlm: LlmClient = {
    extractSkills: vi.fn(async () => [
      { rawName: target!.canonical_name, type: "skill" as const, confidence: 0.7, source: "llm" as const },
    ]),
  };

  const { skillCount } = await processCredential(admin, fakeLlm, cred!.id as string);
  expect(fakeLlm.extractSkills).toHaveBeenCalledTimes(1);
  expect(skillCount).toBe(1);
});
