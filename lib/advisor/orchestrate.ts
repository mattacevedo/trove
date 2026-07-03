// The advisor pipeline's single entry point (mirrors lib/skills/index.ts's processCredential
// shape). Ordering is safety/cost-first: cap check BEFORE any LLM call; gap math already ran in
// loadAdvisorContext (in code); persist BOTH the user turn and the assistant reply with token_cost.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AdvisorLlm,
  AdvisorMessage,
  OccupationCard,
  RunAdvisorTurnResult,
} from "@/lib/advisor/types";
import { checkDailyMessageCap } from "@/lib/advisor/cap";
import { loadAdvisorContext } from "@/lib/advisor/context";
import { SYSTEM_PROMPT, buildContextBlock } from "@/lib/advisor/prompt";
import { shouldUseWebSearch } from "@/lib/advisor/route-topic";

function rowToMessage(row: Record<string, unknown>): AdvisorMessage {
  return {
    id: row.id as string,
    threadId: row.thread_id as string,
    role: row.role as "user" | "assistant",
    content: row.content as string,
    tokenCost: (row.token_cost as number) ?? 0,
    createdAt: row.created_at as string,
  };
}

export async function runAdvisorTurn(
  db: SupabaseClient,
  llm: AdvisorLlm,
  input: { earnerId: string; threadId: string; userMessage: string }
): Promise<RunAdvisorTurnResult> {
  const userMessage = input.userMessage.trim();
  if (!userMessage) return { ok: false, reason: "empty_message" };

  // Confirm the thread exists and is owned (RLS already scopes this to the caller).
  const { data: thread } = await db
    .from("advisor_threads")
    .select("id")
    .eq("id", input.threadId)
    .maybeSingle();
  if (!thread) return { ok: false, reason: "thread_not_found" };

  // COST GUARD: enforce the daily cap BEFORE any paid call. Over-cap => zero tokens spent.
  const cap = await checkDailyMessageCap(db, input.earnerId);
  if (!cap.underCap) return { ok: false, reason: "rate_limited", retryAt: cap.retryAt };

  // Assemble context (gap math runs in code here) and decide web search deterministically.
  const ctx = await loadAdvisorContext(db, input.earnerId, input.threadId);
  const webSearchEnabled = shouldUseWebSearch(userMessage);

  // COST GUARD (part 2): persist the user turn BEFORE the paid llm.reply call. The daily cap
  // counts role='user' rows, so writing this row now means every paid attempt is counted even if
  // llm.reply throws afterward — a user whose calls keep erroring cannot retry indefinitely and
  // burn tokens while the counter never moves. `token_cost: 0` on the user row; the assistant row
  // below carries the real cost. loadAdvisorContext already ran with the pre-insert history, so
  // this new user turn is NOT double-counted into the history handed to the model.
  const { error: userErr } = await db.from("advisor_messages").insert({
    thread_id: input.threadId,
    earner_id: input.earnerId,
    role: "user",
    content: userMessage,
    token_cost: 0,
  });
  if (userErr) throw userErr;

  const reply = await llm.reply({
    systemPrompt: SYSTEM_PROMPT,
    contextBlock: buildContextBlock(ctx),
    history: ctx.history,
    userMessage,
    webSearchEnabled,
  });

  const { data: assistantRow, error: asstErr } = await db
    .from("advisor_messages")
    .insert({
      thread_id: input.threadId,
      earner_id: input.earnerId,
      role: "assistant",
      content: reply.content,
      token_cost: reply.tokenCost,
    })
    .select("id, thread_id, role, content, token_cost, created_at")
    .single();
  if (asstErr) throw asstErr;

  // Attach the conservative v1 unverified-reliance flag to every card so OccupationCard's amber
  // "based partly on an unverified credential" flag is actually reachable (design doc §6). The
  // flag is true whenever the earner has ANY unverified credential — gaps.ts is credential-status
  // -agnostic, so this is a conservative signal, not a per-skill provenance join (deferred).
  const baseGaps = ctx.targetGap ? [ctx.targetGap] : ctx.candidateGaps;
  const occupationCards: OccupationCard[] = baseGaps.map((gap) => ({
    gap,
    reliesOnUnverified: ctx.hasUnverifiedCredentials,
  }));

  return { ok: true, message: rowToMessage(assistantRow), occupationCards };
}
