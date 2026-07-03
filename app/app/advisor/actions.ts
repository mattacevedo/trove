"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { requireUserId } from "@/lib/auth/require-user";
import { createAnthropicAdvisorLlmClient } from "@/lib/advisor/llm";
import { runAdvisorTurn } from "@/lib/advisor/orchestrate";
import type {
  AdvisorMessage,
  AdvisorThreadSummary,
  RunAdvisorTurnResult,
} from "@/lib/advisor/types";

const ADVISOR = "/app/advisor";

/** Create a new thread (title = first ~40 chars of the seed message, or default) and open it. */
export async function createAdvisorThread(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const seed = String(formData.get("message") ?? "").trim();
  const title = seed ? seed.slice(0, 40) : "New conversation";
  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from("advisor_threads")
    .insert({ earner_id: userId, title })
    .select("id")
    .single();
  if (error || !data) redirect(`${ADVISOR}?error=create_failed`);
  revalidatePath(ADVISOR);
  redirect(`${ADVISOR}/${data!.id}`);
}

export async function listAdvisorThreads(): Promise<AdvisorThreadSummary[]> {
  await requireUserId();
  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from("advisor_threads")
    .select("id, title, created_at")
    .order("created_at", { ascending: false });
  if (error) return [];
  return (data ?? []).map((t) => ({
    id: t.id as string,
    title: t.title as string,
    createdAt: t.created_at as string,
  }));
}

export async function getAdvisorThread(threadId: string): Promise<{
  thread: { id: string; title: string; targetOccupationName: string | null };
  messages: AdvisorMessage[];
} | null> {
  const userId = await requireUserId();
  const supabase = await createServerClient();
  const { data: thread } = await supabase
    .from("advisor_threads")
    .select("id, title")
    .eq("id", threadId)
    .maybeSingle();
  if (!thread) return null;

  const { data: earner } = await supabase
    .from("earners")
    .select("target_occupation_skill_id")
    .eq("id", userId)
    .single();
  let targetOccupationName: string | null = null;
  const targetId = (earner?.target_occupation_skill_id as string | null) ?? null;
  if (targetId) {
    const { data: skill } = await supabase
      .from("skills")
      .select("canonical_name")
      .eq("id", targetId)
      .single();
    targetOccupationName = (skill?.canonical_name as string | null) ?? null;
  }

  const { data: msgs } = await supabase
    .from("advisor_messages")
    .select("id, thread_id, role, content, token_cost, created_at")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true });

  return {
    thread: { id: thread.id as string, title: thread.title as string, targetOccupationName },
    messages: (msgs ?? []).map((m) => ({
      id: m.id as string,
      threadId: m.thread_id as string,
      role: m.role as "user" | "assistant",
      content: m.content as string,
      tokenCost: (m.token_cost as number) ?? 0,
      createdAt: m.created_at as string,
    })),
  };
}

/** The core per-message pipeline. Direct-return (not redirect) so the chat UI renders the reply. */
export async function sendAdvisorMessage(
  threadId: string,
  content: string
): Promise<RunAdvisorTurnResult> {
  const userId = await requireUserId();
  const supabase = await createServerClient();
  const result = await runAdvisorTurn(supabase, createAnthropicAdvisorLlmClient(), {
    earnerId: userId,
    threadId,
    userMessage: content,
  });
  revalidatePath(`${ADVISOR}/${threadId}`);
  return result;
}

/** Set (or clear) the durable target occupation. Validates the id is a real occupation skill. */
export async function setTargetOccupation(formData: FormData): Promise<void> {
  const userId = await requireUserId();
  const skillId = String(formData.get("skill_id") ?? "").trim() || null;
  const supabase = await createServerClient();
  if (skillId) {
    const { data: row } = await supabase
      .from("skills")
      .select("id")
      .eq("id", skillId)
      .eq("type", "occupation")
      .maybeSingle();
    if (!row) redirect(`${ADVISOR}?error=invalid_occupation`);
  }
  await supabase
    .from("earners")
    .update({ target_occupation_skill_id: skillId })
    .eq("id", userId);
  revalidatePath(ADVISOR);
  redirect(ADVISOR);
}
