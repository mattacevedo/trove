import { expect, test } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  checkDailyMessageCap,
  startOfTodayAppTz,
  startOfTomorrowAppTz,
  DAILY_MESSAGE_CAP,
  APP_TZ,
} from "./cap";

test("APP_TZ day boundary: 23:59 and 00:01 local land in the correct APP_TZ days", () => {
  // America/New_York is UTC-4 in July (EDT). Local 2026-07-02 00:01 == UTC 04:01.
  // The start-of-day floor for any instant on local 2026-07-02 must be UTC 04:00 that date.
  const justAfterMidnightLocal = new Date("2026-07-02T04:01:00Z"); // 00:01 EDT
  const justBeforeMidnightLocal = new Date("2026-07-02T03:59:00Z"); // 23:59 EDT on 2026-07-01
  expect(startOfTodayAppTz(justAfterMidnightLocal)).toBe("2026-07-02T04:00:00.000Z");
  expect(startOfTodayAppTz(justBeforeMidnightLocal)).toBe("2026-07-01T04:00:00.000Z");
  // They fall on DIFFERENT local days despite being 2 minutes apart in UTC.
  expect(startOfTodayAppTz(justAfterMidnightLocal)).not.toBe(
    startOfTodayAppTz(justBeforeMidnightLocal)
  );
  // Sanity: tomorrow is exactly one local day after today's floor.
  expect(startOfTomorrowAppTz(justAfterMidnightLocal)).toBe("2026-07-03T04:00:00.000Z");
  expect(APP_TZ).toBe("America/New_York");
});

// Minimal shape of the chain checkDailyMessageCap actually calls: .select().eq().eq().gte(),
// awaited directly (PostgREST's builder is thenable). Self-referential so every chained call
// returns something awaitable to the same canned result.
interface FakeCapChain {
  select: () => FakeCapChain;
  eq: () => FakeCapChain;
  gte: (col: string, val: string) => FakeCapChain;
  then: (
    res: (v: { count: number; error: null }) => void
  ) => void;
}

function fakeCapDb(sentToday: number) {
  // Records the gte boundary and returns a canned count for the head:true count query.
  const gteCalls: string[] = [];
  const chain: FakeCapChain = {
    select: () => chain,
    eq: () => chain,
    gte: (_col: string, val: string) => {
      gteCalls.push(val);
      return chain;
    },
    then: (res) => res({ count: sentToday, error: null }),
  };
  return { from: () => chain, gteCalls };
}

test("underCap is sentToday < cap (exclusive of the in-flight turn): cap-1 allows, cap rejects", async () => {
  const under = await checkDailyMessageCap(
    fakeCapDb(DAILY_MESSAGE_CAP - 1) as unknown as SupabaseClient,
    "e1"
  );
  expect(under.underCap).toBe(true);
  expect(under.sentToday).toBe(DAILY_MESSAGE_CAP - 1);

  const at = await checkDailyMessageCap(
    fakeCapDb(DAILY_MESSAGE_CAP) as unknown as SupabaseClient,
    "e1"
  );
  expect(at.underCap).toBe(false); // the (cap+1)-th turn is rejected
  expect(at.retryAt).toMatch(/T04:00:00\.000Z$/); // next APP_TZ midnight, expressed in UTC
});

test("filters the count to today's APP_TZ window floor", async () => {
  const db = fakeCapDb(0);
  await checkDailyMessageCap(db as unknown as SupabaseClient, "e1");
  expect(db.gteCalls[0]).toBe(startOfTodayAppTz());
});
