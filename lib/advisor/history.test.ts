import { expect, test } from "vitest";
import { trimHistory, MAX_HISTORY_TURNS } from "./history";
import type { AdvisorTurn } from "@/lib/advisor/types";

const turn = (i: number): AdvisorTurn => ({ role: "user", content: `m${i}` });

test("keeps only the last MAX_HISTORY_TURNS turns", () => {
  const many = Array.from({ length: 15 }, (_, i) => turn(i));
  const trimmed = trimHistory(many);
  expect(trimmed).toHaveLength(MAX_HISTORY_TURNS);
  expect(trimmed[0].content).toBe("m5");
  expect(trimmed.at(-1)!.content).toBe("m14");
});

test("leaves short all-user histories untouched (same reference); empty stays empty", () => {
  const few = [turn(0), turn(1)];
  expect(trimHistory(few)).toBe(few);
  expect(trimHistory([])).toEqual([]);
});

test("drops leading assistant turns so the window starts with a user turn (Anthropic requires it)", () => {
  const asst = (i: number): AdvisorTurn => ({ role: "assistant", content: `a${i}` });
  // A window that would begin with an assistant turn (e.g. history starts mid-exchange).
  const mixed = [asst(0), turn(1), asst(2), turn(3)];
  const trimmed = trimHistory(mixed);
  expect(trimmed[0].role).toBe("user");
  expect(trimmed.map((t) => t.content)).toEqual(["m1", "a2", "m3"]);
  // All-assistant history collapses to empty rather than leading with assistant.
  expect(trimHistory([asst(0), asst(1)])).toEqual([]);
});
