import { expect, test } from "vitest";
import { adminClient } from "./admin-client";

test("core tables exist and accept a minimal insert", async () => {
  const db = adminClient();

  const { data: user, error: userErr } = await db.auth.admin.createUser({
    email: `schema-${Date.now()}@example.com`,
    email_confirm: true,
  });
  expect(userErr).toBeNull();

  const earnerId = user!.user!.id;
  const { error: earnerErr } = await db
    .from("earners")
    .insert({ id: earnerId, handle: `u${Date.now()}` });
  expect(earnerErr).toBeNull();

  const { error: credErr } = await db.from("credentials").insert({
    earner_id: earnerId,
    source: "manual",
    title: "Forklift Safety",
    verification_status: "unverified",
  });
  expect(credErr).toBeNull();

  // cleanup
  await db.auth.admin.deleteUser(earnerId);
});
