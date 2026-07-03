import { afterAll, expect, test } from "vitest";
import { adminClient } from "./admin-client";
import { makeUserClient } from "./user-client";
import { runAdvisorTurn } from "@/lib/advisor/orchestrate";
import type { AdvisorLlm } from "@/lib/advisor/types";
import { DAILY_MESSAGE_CAP } from "@/lib/advisor/cap";

const admin = adminClient();
const created: string[] = [];

afterAll(async () => {
  for (const id of created) await admin.auth.admin.deleteUser(id);
});

const fakeLlm: AdvisorLlm = {
  async reply() {
    return { content: "Some guidance.", tokenCost: 42, usedWebSearch: false };
  },
};

async function makeEarner(email: string) {
  const { client, userId } = await makeUserClient(email);
  created.push(userId);
  // earners row (RLS earners_self_insert requires id = auth.uid()).
  await client.from("earners").insert({ id: userId, handle: `h${Date.now()}${Math.random().toString(36).slice(2, 6)}` });
  return { client, userId };
}

test("runAdvisorTurn persists owner-scoped thread + user/assistant messages with token_cost", async () => {
  const { client, userId } = await makeEarner(`adv-a-${Date.now()}@example.com`);
  const { data: thread } = await client
    .from("advisor_threads")
    .insert({ earner_id: userId, title: "T" })
    .select("id")
    .single();

  const res = await runAdvisorTurn(client, fakeLlm, {
    earnerId: userId,
    threadId: thread!.id,
    userMessage: "What should I learn next?",
  });
  expect(res.ok).toBe(true);

  const { data: msgs } = await client
    .from("advisor_messages")
    .select("role, content, token_cost")
    .eq("thread_id", thread!.id)
    .order("created_at", { ascending: true });
  expect(msgs?.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(msgs?.find((m) => m.role === "assistant")?.token_cost).toBe(42);
});

test("a second earner cannot read the first earner's thread or messages (RLS)", async () => {
  const a = await makeEarner(`adv-owner-${Date.now()}@example.com`);
  const { data: thread } = await a.client
    .from("advisor_threads")
    .insert({ earner_id: a.userId, title: "Private" })
    .select("id")
    .single();
  await runAdvisorTurn(a.client, fakeLlm, {
    earnerId: a.userId,
    threadId: thread!.id,
    userMessage: "hello",
  });

  const b = await makeEarner(`adv-intruder-${Date.now()}@example.com`);
  const { data: seenThreads } = await b.client.from("advisor_threads").select("id").eq("id", thread!.id);
  expect(seenThreads ?? []).toHaveLength(0);
  const { data: seenMsgs } = await b.client.from("advisor_messages").select("id").eq("thread_id", thread!.id);
  expect(seenMsgs ?? []).toHaveLength(0);
});

test("target_occupation_skill_id FK holds and on-delete-set-null fires", async () => {
  const { client, userId } = await makeEarner(`adv-target-${Date.now()}@example.com`);
  // create a throwaway occupation skill via admin, point the earner at it, then delete it.
  const { data: occ } = await admin
    .from("skills")
    .insert({ canonical_name: `Test Occ ${Date.now()}`, type: "occupation", onet_id: `99-${Date.now()}` })
    .select("id")
    .single();
  await client.from("earners").update({ target_occupation_skill_id: occ!.id }).eq("id", userId);
  await admin.from("skills").delete().eq("id", occ!.id);
  const { data: earner } = await client.from("earners").select("target_occupation_skill_id").eq("id", userId).single();
  expect(earner!.target_occupation_skill_id).toBeNull(); // on delete set null
});

test("the daily cap is enforced on the real table and never calls the LLM once exceeded", async () => {
  const { client, userId } = await makeEarner(`adv-cap-${Date.now()}@example.com`);
  const { data: thread } = await client
    .from("advisor_threads")
    .insert({ earner_id: userId, title: "Cap" })
    .select("id")
    .single();

  // Seed DAILY_MESSAGE_CAP user messages directly, then the next turn must be rate_limited.
  const seedRows = Array.from({ length: DAILY_MESSAGE_CAP }, () => ({
    thread_id: thread!.id,
    earner_id: userId,
    role: "user",
    content: "x",
    token_cost: 0,
  }));
  await client.from("advisor_messages").insert(seedRows);

  let llmCalls = 0;
  const countingLlm: AdvisorLlm = {
    async reply() {
      llmCalls += 1;
      return { content: "nope", tokenCost: 1, usedWebSearch: false };
    },
  };
  const res = await runAdvisorTurn(client, countingLlm, {
    earnerId: userId,
    threadId: thread!.id,
    userMessage: "one more",
  });
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.reason).toBe("rate_limited");
  expect(llmCalls).toBe(0);
});
