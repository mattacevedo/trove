import { afterAll, expect, test } from "vitest";
import { adminClient } from "./admin-client";
import { makeUserClient } from "./user-client";

const admin = adminClient();
const created: string[] = [];

afterAll(async () => {
  for (const id of created) await admin.auth.admin.deleteUser(id);
});

test("an earner cannot read another earner's credentials", async () => {
  const a = await makeUserClient(`a-${Date.now()}@example.com`);
  const b = await makeUserClient(`b-${Date.now()}@example.com`);
  created.push(a.userId, b.userId);

  await a.client.from("earners").insert({ id: a.userId, handle: `a${Date.now()}` });
  await b.client.from("earners").insert({ id: b.userId, handle: `b${Date.now()}` });

  await a.client.from("credentials").insert({
    earner_id: a.userId,
    source: "manual",
    title: "A's private credential",
  });

  // B tries to read A's credentials — RLS must return zero rows.
  const { data } = await b.client
    .from("credentials")
    .select("*")
    .eq("earner_id", a.userId);
  expect(data).toEqual([]);
});

test("an earner can read their own credentials", async () => {
  const a = await makeUserClient(`c-${Date.now()}@example.com`);
  created.push(a.userId);
  await a.client.from("earners").insert({ id: a.userId, handle: `c${Date.now()}` });
  await a.client.from("credentials").insert({
    earner_id: a.userId,
    source: "manual",
    title: "Mine",
  });
  const { data } = await a.client.from("credentials").select("*");
  expect(data).toHaveLength(1);
  expect(data![0].title).toBe("Mine");
});
