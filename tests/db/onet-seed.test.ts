import { expect, test } from "vitest";
import { adminClient } from "./admin-client";

const admin = adminClient();

test("O*NET vocabulary is seeded (run scripts/seed-onet.mjs first)", async () => {
  const { count, error } = await admin
    .from("skills")
    .select("id", { count: "exact", head: true });
  expect(error).toBeNull();
  expect(count ?? 0).toBeGreaterThan(50);
});

test("a known O*NET skill element is present with its element id", async () => {
  const { data } = await admin
    .from("skills")
    .select("canonical_name, type, onet_id")
    .eq("onet_id", "2.A.1.a")
    .maybeSingle();
  // 2.A.1.a is O*NET's "Reading Comprehension" skill element.
  expect(data?.type).toBe("skill");
  expect(data?.canonical_name).toBe("Reading Comprehension");
});
