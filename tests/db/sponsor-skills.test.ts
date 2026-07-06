import { afterAll, expect, test } from "vitest";
import { adminClient } from "./admin-client";
import { makeUserClient } from "./user-client";
import { getSponsorSkillCoverage } from "@/lib/billing/skill-coverage";

const admin = adminClient();
const createdUsers: string[] = [];

afterAll(async () => {
  for (const id of createdUsers) await admin.auth.admin.deleteUser(id);
});

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function seedEarner(): Promise<string> {
  const email = `sk-${uniq()}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (error) throw error;
  const id = data!.user!.id;
  createdUsers.push(id);
  await admin.from("earners").insert({ id, handle: `h${uniq().replace(/[^a-z0-9]/gi, "")}` });
  return id;
}

async function twoSkillIds(): Promise<[string, string]> {
  const { data } = await admin.from("skills").select("id, canonical_name").limit(2);
  expect(data && data.length).toBeGreaterThanOrEqual(2);
  return [data![0].id as string, data![1].id as string];
}

async function giveEarnerSkill(earnerId: string, skillId: string) {
  // earner_skills is the rolled-up profile the coverage RPC aggregates over.
  await admin
    .from("earner_skills")
    .insert({ earner_id: earnerId, skill_id: skillId, source_count: 1, highest_confidence: 1.0 });
}

test("coverage counts consenting members only; admin-guarded", async () => {
  // An admin who owns a sponsor, created via the create_sponsor RPC (Task 1).
  const { client: adminUser, userId: adminUserId } = await makeUserClient(`owner-${uniq()}@example.com`);
  createdUsers.push(adminUserId);
  const { data: sponsorId, error: createErr } = await adminUser.rpc("create_sponsor", {
    sponsor_name: "Skill Co",
  });
  expect(createErr).toBeNull();

  const [skillA] = await twoSkillIds();

  // Member 1: consents to share skills; has skillA.
  const m1 = await seedEarner();
  await giveEarnerSkill(m1, skillA);
  await admin.from("cohort_members").insert({
    sponsor_id: sponsorId,
    earner_id: m1,
    status: "active",
    consent_share_skills: true,
  });

  // Member 2: does NOT consent; also has skillA -> must be excluded from counts.
  const m2 = await seedEarner();
  await giveEarnerSkill(m2, skillA);
  await admin.from("cohort_members").insert({
    sponsor_id: sponsorId,
    earner_id: m2,
    status: "active",
    consent_share_skills: false,
  });

  const rows = await getSponsorSkillCoverage(adminUser, sponsorId as string);
  const skillARow = rows.find((r) => r.memberCount > 0);
  expect(skillARow).toBeDefined();
  // Only the consenting member counts.
  expect(skillARow!.memberCount).toBe(1);
});

test("sponsor_skill_coverage RAISES for a non-admin caller", async () => {
  // Owner creates a sponsor; a DIFFERENT user (not an admin of it) calls the RPC.
  const { client: owner, userId: ownerId } = await makeUserClient(`o2-${uniq()}@example.com`);
  createdUsers.push(ownerId);
  const { data: sponsorId } = await owner.rpc("create_sponsor", {
    sponsor_name: "Guarded Co",
  });

  const { client: outsider, userId: outsiderId } = await makeUserClient(`out-${uniq()}@example.com`);
  createdUsers.push(outsiderId);

  await expect(
    getSponsorSkillCoverage(outsider, sponsorId as string)
  ).rejects.toThrow();
});
