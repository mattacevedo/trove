import { afterAll, expect, test } from "vitest";
import { adminClient } from "@/tests/db/admin-client";
import { provisionEarner } from "./provision-earner";

const admin = adminClient();
const created: string[] = [];

afterAll(async () => {
  for (const id of created) await admin.auth.admin.deleteUser(id);
});

test("provisionEarner creates an earner row once and is idempotent", async () => {
  const email = `prov-${Date.now()}@example.com`;
  const { data } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  const userId = data.user!.id;
  created.push(userId);

  const first = await provisionEarner(admin, userId, email);
  expect(first.handle).toMatch(/^prov/);

  const second = await provisionEarner(admin, userId, email);
  expect(second.handle).toBe(first.handle); // idempotent — same handle

  const { data: rows } = await admin
    .from("earners")
    .select("id")
    .eq("id", userId);
  expect(rows).toHaveLength(1);
});
