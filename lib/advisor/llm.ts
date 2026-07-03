// Advisor LLM adapter (impure) — the ONLY module in lib/advisor/ allowed to import
// @anthropic-ai/sdk. Wraps the Anthropic Messages API behind the pure AdvisorLlm interface from
// lib/advisor/types, with an injectable client (for zero-network unit tests). Mirrors
// lib/skills/llm.ts's AnthropicLike injection pattern and pins the identical model literal.

import Anthropic from "@anthropic-ai/sdk";
import type { AdvisorLlm } from "@/lib/advisor/types";

export const ADVISOR_MODEL = "claude-sonnet-4-6";
export const ADVISOR_MAX_TOKENS = 1024;

/** Anthropic's server-side web-search tool (design doc §6.4). Passed only when enabled. */
const WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search" } as const;

/** Minimal shape of the Anthropic client we depend on (injectable for tests). */
export interface AnthropicLike {
  messages: {
    create(args: unknown): Promise<{
      content: Array<{ type: string } & Record<string, unknown>>;
      usage?: { input_tokens?: number; output_tokens?: number };
    }>;
  };
}

export function createAnthropicAdvisorLlmClient(opts?: {
  apiKey?: string;
  client?: AnthropicLike;
}): AdvisorLlm {
  const client: AnthropicLike =
    opts?.client ??
    (new Anthropic({
      apiKey: opts?.apiKey ?? process.env.ANTHROPIC_API_KEY,
    }) as unknown as AnthropicLike);

  return {
    async reply(input) {
      // PRECONDITION: input.history must begin with a `user` turn and alternate — Anthropic rejects
      // a leading `assistant` message with a 400. trimHistory (lib/advisor/history.ts) guarantees
      // this by dropping any leading assistant turn(s); this adapter does not re-shape history.
      // The web_search tool (when enabled) is Anthropic's SERVER-side tool: Anthropic runs the
      // search inline within this single create() call and returns the final text in the same
      // response — no client-side tool loop is needed. We therefore treat one round-trip as final.
      const response = await client.messages.create({
        model: ADVISOR_MODEL,
        max_tokens: ADVISOR_MAX_TOKENS,
        system: `${input.systemPrompt}\n\n${input.contextBlock}`,
        ...(input.webSearchEnabled ? { tools: [WEB_SEARCH_TOOL] } : {}),
        messages: [
          ...input.history.map((t) => ({ role: t.role, content: t.content })),
          { role: "user", content: input.userMessage },
        ],
      });

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text?: string }).text ?? "")
        .join("")
        .trim();

      const usedWebSearch = response.content.some(
        (b) => b.type === "web_search_tool_result" || b.type === "server_tool_use"
      );

      const tokenCost =
        (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);

      return { content: text, tokenCost, usedWebSearch };
    },
  };
}
