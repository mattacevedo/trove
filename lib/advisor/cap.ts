// Per-earner daily message cap — a "not rich" cost guardrail (design doc §6). Counted from
// advisor_messages (role='user', created_at >= start of the current APP_TZ day) so no new table
// is needed. Enforced by the orchestrator BEFORE any LLM call, so an over-cap turn spends zero
// tokens. The window is pinned to ONE explicit operator-controlled timezone (APP_TZ) rather than
// UTC: a UTC window resets the cap mid-afternoon US-local, letting a user get ~cap messages before
// the reset and ~cap more after (~2x the intended daily spend on the local-day boundary), which
// would undercut the hard cost ceiling. Change APP_TZ in one place to move the boundary.
//
// Cap semantics (documented so a fresh executor keeps them consistent): checkDailyMessageCap is
// called by the orchestrator BEFORE it inserts the in-flight user turn, so `sentToday` is the
// count of ALREADY-persisted user turns today, EXCLUSIVE of the current one. `underCap` is
// `sentToday < cap`, so the current turn is allowed while fewer than `cap` turns already exist —
// i.e. exactly `cap` successful user turns are permitted per day (turns 1..cap), and the
// (cap+1)-th is rejected. Because orchestrate.ts persists the user turn immediately after this
// check passes, a paid call that later errors is still counted (no free infinite retries).

import type { SupabaseClient } from "@supabase/supabase-js";

export const DAILY_MESSAGE_CAP = 20;

/**
 * The single timezone the daily-cap window is anchored to. IANA name; the operator sets this to
 * their own locale so "one day" of messages matches a human calendar day, not a UTC day. Kept a
 * named constant (not read from env) so the boundary is deterministic and unit-testable.
 */
export const APP_TZ = "America/New_York";

/**
 * The UTC offset (in ms) of APP_TZ at a given instant, derived with no external tz library and
 * INDEPENDENT of the runner's own timezone. We format `instant` into APP_TZ wall-clock parts, read
 * those parts back AS IF they were UTC, and subtract the real epoch: the difference is the zone's
 * offset (positive east of UTC). This correctly follows DST because Intl resolves the offset for
 * that specific instant. (The naive `new Date(d.toLocaleString(...))` trick is avoided because
 * Date parsing of a locale string uses the RUNNER's tz, which would make the result machine-
 * dependent.)
 */
function appTzOffsetMs(instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  // Some engines format midnight as hour "24"; normalize to 0.
  const hour = get("hour") % 24;
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return asUtc - instant.getTime();
}

/**
 * The instant of midnight (00:00) in APP_TZ for the day containing `at`, returned as a UTC ISO
 * string. Read the APP_TZ wall-clock Y/M/D for `at`, treat that Y/M/D 00:00 as a provisional UTC
 * instant, then subtract the zone's offset at that provisional instant to land on the true UTC
 * moment of APP_TZ midnight. `dayDelta` shifts to a neighboring day (e.g. +1 for start of tomorrow,
 * the capped earner's retryAt). Runner-timezone-independent; DST-correct.
 */
function startOfAppTzDay(at: Date, dayDelta = 0): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const provisional = Date.UTC(get("year"), get("month") - 1, get("day") + dayDelta, 0, 0, 0);
  const offsetMs = appTzOffsetMs(new Date(provisional));
  return new Date(provisional - offsetMs).toISOString();
}

/**
 * Start of the APP_TZ day containing `at` (window floor), exported for the boundary unit test.
 * `startOfTomorrowAppTz` reuses it with dayDelta:+1 for the capped earner's retryAt.
 */
export function startOfTodayAppTz(at: Date = new Date()): string {
  return startOfAppTzDay(at, 0);
}
export function startOfTomorrowAppTz(at: Date = new Date()): string {
  return startOfAppTzDay(at, 1);
}

export async function checkDailyMessageCap(
  db: SupabaseClient,
  earnerId: string,
  cap: number = DAILY_MESSAGE_CAP
): Promise<{ underCap: boolean; sentToday: number; retryAt: string }> {
  const { count, error } = await db
    .from("advisor_messages")
    .select("*", { count: "exact", head: true })
    .eq("earner_id", earnerId)
    .eq("role", "user")
    .gte("created_at", startOfTodayAppTz());
  if (error) throw error;
  const sentToday = count ?? 0;
  return { underCap: sentToday < cap, sentToday, retryAt: startOfTomorrowAppTz() };
}
