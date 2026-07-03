import { expect, test, vi } from "vitest";
import { createAnthropicAdvisorLlmClient, ADVISOR_MODEL, ADVISOR_MAX_TOKENS } from "./llm";
import type { AnthropicLike } from "./llm";

function fakeClient(overrides?: Record<string, unknown>) {
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

test("handles a tool-only / empty-text response without crashing", async () => {
  // The model can return a response with no assistant `text` block — e.g. only a server_tool_use
  // block (or an empty content array). The adapter filters for `text` blocks and joins them, so it
  // must yield content "" (not throw) and still produce a well-formed { content, tokenCost,
  // usedWebSearch }. Missing usage must degrade to tokenCost 0 via the `?? 0` guards.
  const { client } = fakeClient({
    content: [{ type: "server_tool_use", id: "srvtool_1", name: "web_search", input: {} }],
    usage: undefined,
  });
  const llm = createAnthropicAdvisorLlmClient({ client });
  const out = await llm.reply({
    systemPrompt: "SYS",
    contextBlock: "CTX",
    history: [],
    userMessage: "any openings today?",
    webSearchEnabled: true,
  });
  expect(out.content).toBe(""); // no text block -> empty string, not a throw
  expect(out.tokenCost).toBe(0); // absent usage -> 0
  expect(typeof out.usedWebSearch).toBe("boolean");

  // A fully empty content array is likewise tolerated.
  const { client: emptyClient } = fakeClient({ content: [], usage: { input_tokens: 5 } });
  const emptyLlm = createAnthropicAdvisorLlmClient({ client: emptyClient });
  const emptyOut = await emptyLlm.reply({
    systemPrompt: "SYS",
    contextBlock: "CTX",
    history: [],
    userMessage: "hello",
    webSearchEnabled: false,
  });
  expect(emptyOut.content).toBe("");
  expect(emptyOut.tokenCost).toBe(5);
  expect(emptyOut.usedWebSearch).toBe(false);
});

test("detects usedWebSearch: true from a web_search_tool_result block", async () => {
  // The adapter keys usedWebSearch off the presence of a web_search_tool_result or server_tool_use
  // block in the response content (lib/advisor/llm.ts). A response carrying that block — alongside
  // the model's final text — must set usedWebSearch true while still extracting the text and cost.
  const { client } = fakeClient({
    content: [
      { type: "server_tool_use", id: "srvtool_1", name: "web_search", input: { query: "jobs" } },
      { type: "web_search_tool_result", tool_use_id: "srvtool_1", content: [] },
      { type: "text", text: "Here are some current openings." },
    ],
    usage: { input_tokens: 200, output_tokens: 60 },
  });
  const llm = createAnthropicAdvisorLlmClient({ client });
  const out = await llm.reply({
    systemPrompt: "SYS",
    contextBlock: "CTX",
    history: [],
    userMessage: "any openings today?",
    webSearchEnabled: true,
  });
  expect(out.usedWebSearch).toBe(true);
  expect(out.content).toBe("Here are some current openings.");
  expect(out.tokenCost).toBe(260);
});
