import { expect, test, vi } from "vitest";
import { createAnthropicAdvisorLlmClient, ADVISOR_MODEL, ADVISOR_MAX_TOKENS } from "./llm";
import type { AnthropicLike } from "./llm";

function fakeClient(overrides?: Partial<ReturnType<typeof makeResponse>>) {
  const create = vi.fn().mockResolvedValue(makeResponse(overrides));
  const client: AnthropicLike = { messages: { create } };
  return { client, create };
}
function makeResponse(overrides?: Record<string, unknown>) {
  return {
    content: [{ type: "text", text: "Here is some guidance." }],
    usage: { input_tokens: 100, output_tokens: 40 },
    ...overrides,
  };
}

test("pins the Sonnet model and a bounded max_tokens; passes system + context", async () => {
  const { client, create } = fakeClient();
  const llm = createAnthropicAdvisorLlmClient({ client });
  await llm.reply({
    systemPrompt: "SYS",
    contextBlock: "CTX",
    history: [{ role: "user", content: "hi" }],
    userMessage: "what next?",
    webSearchEnabled: false,
  });
  const args = create.mock.calls[0][0] as Record<string, unknown>;
  expect(args.model).toBe(ADVISOR_MODEL);
  expect(args.model).toBe("claude-sonnet-4-6");
  expect(args.max_tokens).toBe(ADVISOR_MAX_TOKENS);
  expect(args.system).toContain("SYS");
  expect(args.system).toContain("CTX");
  expect(args.tools).toBeUndefined(); // web search off
});

test("includes the web_search tool only when webSearchEnabled", async () => {
  const { client, create } = fakeClient();
  const llm = createAnthropicAdvisorLlmClient({ client });
  await llm.reply({
    systemPrompt: "SYS",
    contextBlock: "CTX",
    history: [],
    userMessage: "any openings today?",
    webSearchEnabled: true,
  });
  const args = create.mock.calls[0][0] as { tools?: Array<{ name: string }> };
  expect(args.tools?.[0]?.name).toBe("web_search");
});

test("maps usage to tokenCost and extracts text content", async () => {
  const { client } = fakeClient();
  const llm = createAnthropicAdvisorLlmClient({ client });
  const out = await llm.reply({
    systemPrompt: "SYS",
    contextBlock: "CTX",
    history: [],
    userMessage: "hello",
    webSearchEnabled: false,
  });
  expect(out.content).toBe("Here is some guidance.");
  expect(out.tokenCost).toBe(140);
  expect(out.usedWebSearch).toBe(false);
});
