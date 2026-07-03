// Pure history trimming — hard tail-window cap so thread token cost cannot silently balloon.
// v1 uses no LLM summarization (avoids a second paid call to shrink context).
//
// IMPORTANT (real-API correctness): the Anthropic Messages API requires the messages array to
// begin with a `user` turn and to alternate. llm.ts hands this trimmed history to the SDK verbatim
// (before appending the new user turn), so a window that begins with an `assistant` turn would
// 400 on the first real production call — and the injected fake never validates alternation, so
// tests wouldn't catch it. Therefore trimHistory drops any leading `assistant` turn(s) AFTER
// tail-windowing, guaranteeing the returned history starts with a `user` turn (or is empty).

import type { AdvisorTurn } from "@/lib/advisor/types";

export const MAX_HISTORY_TURNS = 10;

export function trimHistory(
  messages: AdvisorTurn[],
  maxTurns: number = MAX_HISTORY_TURNS
): AdvisorTurn[] {
  const windowed =
    messages.length <= maxTurns
      ? messages
      : messages.slice(messages.length - maxTurns);
  // Drop leading assistant turn(s) so the window Anthropic sees starts with a user turn.
  let start = 0;
  while (start < windowed.length && windowed[start].role !== "user") start += 1;
  // Only allocate a new array when we actually trimmed a leading assistant run.
  return start === 0 ? windowed : windowed.slice(start);
}
