import { afterAll, expect, test } from "vitest";
import { adminClient } from "./admin-client";
import { makeUserClient } from "./user-client";

const admin = adminClient();
const created: string[] = [];

afterAll(async () => {
  for (const id of created) await admin.auth.admin.deleteUser(id);
});

test("occupation_skills has been seeded and its FK join to skills resolves", async () => {
  const { count, error } = await admin
    .from("occupation_skills")
    .select("*", { count: "exact", head: true });
  expect(error).toBeNull();
  expect(count ?? 0).toBeGreaterThan(0);

  const { data, error: joinErr } = await admin
    .from("occupation_skills")
    .select("importance, occupation:skills!occupation_skills_occupation_id_fkey(canonical_name), skill:skills!occupation_skills_skill_id_fkey(canonical_name)")
    .limit(1);
  expect(joinErr).toBeNull();
  expect(data?.[0]).toBeTruthy();
});

test("occupation_skills is world-readable but not client-writable", async () => {
  const { client, userId } = await makeUserClient(`os-rls-${Date.now()}@example.com`);
  created.push(userId);

  const { error: readErr } = await client
    .from("occupation_skills")
    .select("occupation_id", { head: true })
    .limit(1);
  expect(readErr).toBeNull(); // read_all policy

  // pick a real (occupation, skill) pair to satisfy the FKs, then confirm the full write surface
  // (INSERT / UPDATE / DELETE) is rejected — only occupation_skills_read_all (SELECT) exists.
  const { data: occ } = await admin.from("skills").select("id").eq("type", "occupation").limit(1).single();
  const { data: sk } = await admin.from("skills").select("id").eq("type", "skill").limit(1).single();

  const { error: insertErr } = await client
    .from("occupation_skills")
    .insert({ occupation_id: occ!.id, skill_id: sk!.id, importance: 4 });
  expect(insertErr).not.toBeNull(); // no insert policy for the authenticated role

  // UPDATE against an existing seeded row (or a no-match filter) must be blocked / affect no rows.
  const { data: existing } = await admin
    .from("occupation_skills")
    .select("occupation_id, skill_id")
    .limit(1)
    .single();
  const { data: updRows, error: updErr } = await client
    .from("occupation_skills")
    .update({ importance: 1 })
    .eq("occupation_id", existing!.occupation_id)
    .eq("skill_id", existing!.skill_id)
    .select();
  // With no UPDATE policy, RLS either errors or silently matches zero rows — assert nothing changed.
  expect(updErr !== null || (updRows ?? []).length === 0).toBe(true);

  const { data: delRows, error: delErr } = await client
    .from("occupation_skills")
    .delete()
    .eq("occupation_id", existing!.occupation_id)
    .eq("skill_id", existing!.skill_id)
    .select();
  expect(delErr !== null || (delRows ?? []).length === 0).toBe(true);

  // Confirm the seeded row is untouched via the admin (RLS-bypassing) client.
  const { data: after } = await admin
    .from("occupation_skills")
    .select("importance")
    .eq("occupation_id", existing!.occupation_id)
    .eq("skill_id", existing!.skill_id)
    .single();
  expect(after!.importance).not.toBe(1);
});
