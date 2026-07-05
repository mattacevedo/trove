import { expect, test, vi } from "vitest";
import { getSponsorSkillCoverage } from "./skill-coverage";
import type { SupabaseClient } from "@supabase/supabase-js";

function fakeDb(rpcResult: { data: unknown; error: unknown }): SupabaseClient {
  return {
    rpc: vi.fn().mockResolvedValue(rpcResult),
  } as unknown as SupabaseClient;
}

test("maps snake_case RPC rows to SkillCoverageRow, preserving order", async () => {
  const db = fakeDb({
    data: [
      { skill_name: "Python", member_count: 7 },
      { skill_name: "SQL", member_count: 3 },
    ],
    error: null,
  });
  const rows = await getSponsorSkillCoverage(db, "sponsor-1");
  expect(rows).toEqual([
    { skillName: "Python", memberCount: 7 },
    { skillName: "SQL", memberCount: 3 },
  ]);
  expect(db.rpc).toHaveBeenCalledWith("sponsor_skill_coverage", {
    target_sponsor: "sponsor-1",
  });
});

test("returns [] when RPC yields no rows (null data)", async () => {
  const db = fakeDb({ data: null, error: null });
  expect(await getSponsorSkillCoverage(db, "sponsor-1")).toEqual([]);
});

test("throws when RPC returns an error", async () => {
  const db = fakeDb({ data: null, error: { message: "not authorized" } });
  await expect(getSponsorSkillCoverage(db, "sponsor-1")).rejects.toThrow(
    "not authorized"
  );
});
