import { expect, test, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runAdvisorTurn } from "./orchestrate";
import type { AdvisorLlm } from "@/lib/advisor/types";

// --- Minimal fake Supabase client ---------------------------------------------------------
// Supports the specific query chains issued by cap.ts, context.ts, and orchestrate.ts:
//   - advisor_threads: .select().eq().maybeSingle()
//   - advisor_messages (cap check): .select(cols,{count,head}).eq().eq().gte() (thenable)
//   - earner_skills / credentials: .select().eq() (thenable)
//   - earners: .select().eq().single()
//   - occupation_skills: .select()[.eq()].range() (thenable)
//   - advisor_messages (history): .select().eq().order() (thenable)
//   - advisor_messages (insert user turn): .insert(row) (thenable, no .select())
//   - advisor_messages (insert assistant turn): .insert(row).select(cols).single()
// This is a hand-rolled stand-in for the PostgREST query builder (itself "thenable"), not a real
// SupabaseClient — callers cast it at the boundary, matching the precedent in cap.test.ts. Each
// table returns canned data; insert() records rows so tests can assert what was persisted.

type Row = Record<string, unknown>;

interface FakeChain {
  select: (cols?: string, cfg?: { count?: string; head?: boolean }) => FakeChain;
  eq: (col: string, val: unknown) => FakeChain;
  gte: (col: string, val: unknown) => FakeChain;
  order: (col: string, cfg?: { ascending?: boolean }) => FakeChain;
  range: (from: number, to: number) => FakeChain;
  maybeSingle: () => Promise<{ data: Row | null; error: null }>;
  single: () => Promise<{ data: Row | null; error: null }>;
  insert: (row: Row) => FakeChain;
  then: (resolve: (v: { data?: unknown; count?: number; error: null }) => void) => void;
}

function makeFakeDb(opts: { userMessagesToday: number; threadExists?: boolean }) {
  const inserted: Row[] = [];
  const threadExists = opts.threadExists ?? true;

  function rowsFor(table: string): unknown[] {
    if (table === "earner_skills") return [{ skill_id: "sk1" }];
    if (table === "credentials")
      return [{ title: "Cert", issuer_name: "Iss", verification_status: "unverified" }];
    if (table === "occupation_skills") return [];
    if (table === "advisor_messages") return []; // history load (chronological turns)
    return [];
  }

  function from(table: string): FakeChain {
    let countMode: string | undefined;
    let lastInsertedRow: Row | null = null;

    const chain: FakeChain = {
      select(_cols, cfg) {
        countMode = cfg?.count;
        return chain;
      },
      eq() {
        return chain;
      },
      gte() {
        return chain;
      },
      order() {
        return chain;
      },
      range() {
        return chain;
      },
      maybeSingle() {
        if (table === "advisor_threads")
          return Promise.resolve({ data: threadExists ? { id: "t1" } : null, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      single() {
        if (table === "earners")
          return Promise.resolve({ data: { target_occupation_skill_id: null }, error: null });
        // assistant insert().select().single()
        return Promise.resolve({
          data: lastInsertedRow
            ? {
                id: "m-asst",
                thread_id: lastInsertedRow.thread_id,
                role: lastInsertedRow.role,
                content: lastInsertedRow.content,
                token_cost: lastInsertedRow.token_cost,
                created_at: "2026-07-02T00:00:00Z",
              }
            : null,
          error: null,
        });
      },
      insert(row: Row) {
        inserted.push(row);
        lastInsertedRow = row;
        return chain;
      },
      then(resolve) {
        if (table === "advisor_messages" && countMode === "exact") {
          resolve({ count: opts.userMessagesToday, error: null });
          return;
        }
        resolve({ data: rowsFor(table), error: null });
      },
    };
    return chain;
  }

  return { from, inserted };
}

function fakeLlm(): AdvisorLlm & { reply: ReturnType<typeof vi.fn> } {
  const reply = vi.fn().mockResolvedValue({
    content: "Guidance here.",
    tokenCost: 123,
    usedWebSearch: false,
  });
  return { reply };
}

test("happy path persists user + assistant rows and returns ok with token_cost", async () => {
  const db = makeFakeDb({ userMessagesToday: 0 });
  const llm = fakeLlm();
  const res = await runAdvisorTurn(db as unknown as SupabaseClient, llm, {
    earnerId: "e1",
    threadId: "t1",
    userMessage: "What should I learn next?",
  });
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.message.content).toBe("Guidance here.");
    expect(res.message.tokenCost).toBe(123);
  }
  const roles = db.inserted.map((r) => r.role);
  expect(roles).toEqual(["user", "assistant"]);
  expect(db.inserted[0].token_cost).toBe(0);
  expect(db.inserted[1].token_cost).toBe(123);
  expect(llm.reply).toHaveBeenCalledTimes(1);
});

test("empty message short-circuits without calling the LLM", async () => {
  const db = makeFakeDb({ userMessagesToday: 0 });
  const llm = fakeLlm();
  const res = await runAdvisorTurn(db as unknown as SupabaseClient, llm, {
    earnerId: "e1",
    threadId: "t1",
    userMessage: "   ",
  });
  expect(res).toEqual({ ok: false, reason: "empty_message" });
  expect(llm.reply).not.toHaveBeenCalled();
  expect(db.inserted).toHaveLength(0);
});

test("rate-limited path never calls the LLM and spends zero tokens", async () => {
  const db = makeFakeDb({ userMessagesToday: 20 }); // == DAILY_MESSAGE_CAP
  const llm = fakeLlm();
  const res = await runAdvisorTurn(db as unknown as SupabaseClient, llm, {
    earnerId: "e1",
    threadId: "t1",
    userMessage: "one more question",
  });
  expect(res.ok).toBe(false);
  if (!res.ok && res.reason === "rate_limited") {
    expect(res.reason).toBe("rate_limited");
    expect(res.retryAt).toBeTruthy();
  }
  expect(llm.reply).not.toHaveBeenCalled();
  expect(db.inserted).toHaveLength(0);
});

test("missing thread returns thread_not_found without calling the LLM", async () => {
  const db = makeFakeDb({ userMessagesToday: 0, threadExists: false });
  const llm = fakeLlm();
  const res = await runAdvisorTurn(db as unknown as SupabaseClient, llm, {
    earnerId: "e1",
    threadId: "missing",
    userMessage: "hello",
  });
  expect(res).toEqual({ ok: false, reason: "thread_not_found" });
  expect(llm.reply).not.toHaveBeenCalled();
  expect(db.inserted).toHaveLength(0);
});

test("llm.reply throwing after the user row is inserted still leaves the user row persisted", async () => {
  const db = makeFakeDb({ userMessagesToday: 0 });
  const reply = vi.fn().mockRejectedValue(new Error("upstream LLM failure"));
  const llm: AdvisorLlm = { reply };
  await expect(
    runAdvisorTurn(db as unknown as SupabaseClient, llm, {
      earnerId: "e1",
      threadId: "t1",
      userMessage: "What should I learn next?",
    })
  ).rejects.toThrow("upstream LLM failure");

  // The user turn was persisted BEFORE the failing LLM call, so a failed/retried attempt is still
  // counted toward the daily cap (no free infinite retries) and no assistant row was written.
  expect(db.inserted).toHaveLength(1);
  expect(db.inserted[0].role).toBe("user");
  expect(db.inserted[0].token_cost).toBe(0);
  expect(reply).toHaveBeenCalledTimes(1);
});
