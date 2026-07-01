import { expect, test } from "vitest";
import { adminClient } from "./admin-client";

// Confirms scripts/seed-onet.mjs has actually been run against this database —
// not a re-parse of the O*NET files (that's covered by lib/skills/onet-parse.test.ts),
// just a presence check that the hosted `skills` table has real vocabulary rows of
// each seeded type. Guards against later Plan 2 tasks (matching engine, etc.) silently
// operating on an empty table.
test("skills table has been seeded with O*NET vocabulary", async () => {
  const db = adminClient();

  const counts: Record<string, number> = {};
  for (const type of ["occupation", "skill", "competency"] as const) {
    const { count, error } = await db
      .from("skills")
      .select("*", { count: "exact", head: true })
      .eq("type", type);
    expect(error).toBeNull();
    counts[type] = count ?? 0;
  }

  expect(counts.occupation).toBeGreaterThan(0);
  expect(counts.skill).toBeGreaterThan(0);
  expect(counts.competency).toBeGreaterThan(0);

  // A handful of onet_id values must be present on occupations/skills (not just
  // canonical_name) — confirms the seed wrote onet_id, not just placeholder rows.
  const { data: withOnetId, error: onetErr } = await db
    .from("skills")
    .select("onet_id")
    .in("type", ["occupation", "skill"])
    .not("onet_id", "is", null)
    .limit(1);
  expect(onetErr).toBeNull();
  expect(withOnetId?.length ?? 0).toBeGreaterThan(0);
});
