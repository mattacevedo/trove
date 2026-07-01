import { afterAll, expect, test } from "vitest";
import { adminClient } from "./admin-client";
import {
  writeCredentialSkills,
  recomputeEarnerSkills,
  getSkillVocabulary,
} from "@/lib/skills/data";
import type { NormalizedSkillMatch } from "@/lib/skills/types";

const admin = adminClient();
const created: string[] = [];

afterAll(async () => {
  for (const id of created) await admin.auth.admin.deleteUser(id);
});

async function seedEarnerWithCredential() {
  const email = `roll-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const { data: u } = await admin.auth.admin.createUser({ email, email_confirm: true });
  const earnerId = u!.user!.id;
  created.push(earnerId);
  await admin.from("earners").insert({ id: earnerId, handle: `h${Date.now()}${Math.floor(Math.random() * 1000)}` });
  const { data: cred } = await admin
    .from("credentials")
    .insert({ earner_id: earnerId, source: "manual", title: "Test Cred" })
    .select("id")
    .single();
  return { earnerId, credentialId: cred!.id as string };
}

async function twoSeededSkillIds(): Promise<[string, string]> {
  const vocab = await getSkillVocabulary(admin);
  expect(vocab.length).toBeGreaterThanOrEqual(2);
  return [vocab[0].id, vocab[1].id];
}

async function addCredential(earnerId: string): Promise<string> {
  const { data: cred } = await admin
    .from("credentials")
    .insert({ earner_id: earnerId, source: "manual", title: "Test Cred 2" })
    .select("id")
    .single();
  return cred!.id as string;
}

function match(skillId: string, confidence: number): NormalizedSkillMatch {
  return { candidate: "x", skillId, confidence, method: "exact" };
}

test("recompute aggregates source_count and highest_confidence", async () => {
  const { earnerId, credentialId } = await seedEarnerWithCredential();
  const [s1] = await twoSeededSkillIds();
  // Two matches for the same skill in one credential -> collapses to one row (max conf).
  await writeCredentialSkills(admin, credentialId, [match(s1, 0.6), match(s1, 0.9)]);
  const { skillCount } = await recomputeEarnerSkills(admin, earnerId);
  expect(skillCount).toBe(1);
  const { data } = await admin
    .from("earner_skills")
    .select("skill_id, source_count, highest_confidence")
    .eq("earner_id", earnerId);
  expect(data).toHaveLength(1);
  expect(data![0].source_count).toBe(1);
  expect(data![0].highest_confidence).toBeCloseTo(0.9);
});

test("recompute is idempotent across repeated calls", async () => {
  const { earnerId, credentialId } = await seedEarnerWithCredential();
  const [s1] = await twoSeededSkillIds();
  await writeCredentialSkills(admin, credentialId, [match(s1, 0.7)]);
  await recomputeEarnerSkills(admin, earnerId);
  await recomputeEarnerSkills(admin, earnerId);
  const { data } = await admin.from("earner_skills").select("*").eq("earner_id", earnerId);
  expect(data).toHaveLength(1);
});

test("recompute after credential deletion removes the skill", async () => {
  const { earnerId, credentialId } = await seedEarnerWithCredential();
  const [s1] = await twoSeededSkillIds();
  await writeCredentialSkills(admin, credentialId, [match(s1, 0.8)]);
  await recomputeEarnerSkills(admin, earnerId);
  await admin.from("credentials").delete().eq("id", credentialId); // cascades credential_skills
  const { skillCount } = await recomputeEarnerSkills(admin, earnerId);
  expect(skillCount).toBe(0);
  const { data } = await admin.from("earner_skills").select("*").eq("earner_id", earnerId);
  expect(data).toEqual([]);
});

test("no credential_skills -> skillCount 0, no rows", async () => {
  const { earnerId } = await seedEarnerWithCredential();
  const { skillCount } = await recomputeEarnerSkills(admin, earnerId);
  expect(skillCount).toBe(0);
});

test("recompute counts distinct contributing credentials, not distinct credential_skills rows", async () => {
  // Regression guard: recomputeEarnerSkills must group credential_skills by credential_id
  // before rolling up. If it regressed to grouping by skill_id instead, source_count would
  // stay 1 here even though two separate credentials each contribute the same skill.
  const { earnerId, credentialId: credentialId1 } = await seedEarnerWithCredential();
  const credentialId2 = await addCredential(earnerId);
  const [s1] = await twoSeededSkillIds();

  await writeCredentialSkills(admin, credentialId1, [match(s1, 0.6)]);
  await writeCredentialSkills(admin, credentialId2, [match(s1, 0.85)]);

  const { skillCount } = await recomputeEarnerSkills(admin, earnerId);
  expect(skillCount).toBe(1);

  const { data } = await admin
    .from("earner_skills")
    .select("skill_id, source_count, highest_confidence")
    .eq("earner_id", earnerId);
  expect(data).toHaveLength(1);
  expect(data![0].skill_id).toBe(s1);
  expect(data![0].source_count).toBe(2);
  expect(data![0].highest_confidence).toBeCloseTo(0.85);

  // Dropping one credential's contribution should bring the count back down to 1, proving
  // recompute fully re-aggregates from current state rather than accumulating.
  await writeCredentialSkills(admin, credentialId2, []);
  const { skillCount: skillCountAfter } = await recomputeEarnerSkills(admin, earnerId);
  expect(skillCountAfter).toBe(1);
  const { data: dataAfter } = await admin
    .from("earner_skills")
    .select("skill_id, source_count, highest_confidence")
    .eq("earner_id", earnerId);
  expect(dataAfter).toHaveLength(1);
  expect(dataAfter![0].source_count).toBe(1);
  expect(dataAfter![0].highest_confidence).toBeCloseTo(0.6);
});

test("earner A recompute never writes earner B rows", async () => {
  const a = await seedEarnerWithCredential();
  const b = await seedEarnerWithCredential();
  const [s1] = await twoSeededSkillIds();
  await writeCredentialSkills(admin, a.credentialId, [match(s1, 0.9)]);
  await recomputeEarnerSkills(admin, a.earnerId);
  const { data } = await admin.from("earner_skills").select("*").eq("earner_id", b.earnerId);
  expect(data).toEqual([]);
});
