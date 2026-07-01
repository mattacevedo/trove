// LLM adapter (impure) - the ONLY module in lib/skills/ allowed to import
// @anthropic-ai/sdk. Wraps the Anthropic Messages API behind the pure
// `LlmClient` interface from lib/skills/types, with an injectable client
// (for zero-network unit tests) and an in-memory content-hash cache so
// duplicate credentials never re-call the model.

import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type {
  LlmClient,
  RawSkillMention,
  SkillExtractionCache,
  SkillType,
} from "@/lib/skills/types";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 300;
const LLM_CONFIDENCE = 0.7;

/** Minimal shape of the Anthropic client we depend on (injectable for tests). */
export interface AnthropicLike {
  messages: {
    create(args: unknown): Promise<{
      content: Array<{ type: string } & Record<string, unknown>>;
    }>;
  };
}

export class InMemorySkillCache implements SkillExtractionCache {
  private store = new Map<string, RawSkillMention[]>();
  async get(key: string): Promise<RawSkillMention[] | null> {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  async set(key: string, value: RawSkillMention[]): Promise<void> {
    this.store.set(key, value);
  }
}

/** Content-hash key over title+description only - never raw_json. */
export function cacheKey(input: { title: string; description: string }): string {
  return createHash("sha256")
    .update(`${input.title} ${input.description}`)
    .digest("hex");
}

function toSkillType(t: unknown): SkillType {
  return t === "competency" || t === "occupation" ? t : "skill";
}

/** Cap confidence at the LLM ceiling and tag source. */
export function clampMentions(mentions: RawSkillMention[]): RawSkillMention[] {
  return mentions.map((m) => ({
    ...m,
    source: "llm" as const,
    confidence: Math.min(m.confidence, LLM_CONFIDENCE),
  }));
}

const SYSTEM_PROMPT =
  "You extract concrete, resume-relevant skills from a credential's title and description. " +
  "Return only skills a person could reasonably claim from earning this credential. " +
  "Do not invent skills that are not implied by the text.";

const SKILLS_TOOL = {
  name: "record_skills",
  description: "Record the skills extracted from the credential.",
  input_schema: {
    type: "object",
    properties: {
      skills: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            type: { type: "string", enum: ["skill", "competency", "occupation"] },
          },
          required: ["name", "type"],
        },
      },
    },
    required: ["skills"],
  },
} as const;

export function createAnthropicLlmClient(opts?: {
  apiKey?: string;
  cache?: SkillExtractionCache;
  client?: AnthropicLike;
}): LlmClient {
  const cache = opts?.cache ?? new InMemorySkillCache();
  const client: AnthropicLike =
    opts?.client ??
    (new Anthropic({
      apiKey: opts?.apiKey ?? process.env.ANTHROPIC_API_KEY,
    }) as unknown as AnthropicLike);

  return {
    async extractSkills(input) {
      const key = cacheKey(input);
      const cached = await cache.get(key);
      if (cached) return cached;

      const response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        tools: [SKILLS_TOOL],
        tool_choice: { type: "tool", name: "record_skills" },
        messages: [
          {
            role: "user",
            content:
              `Title: ${input.title}\nDescription: ${input.description}\n\n` +
              "Extract the skills using the record_skills tool.",
          },
        ],
      });

      const toolBlock = response.content.find((b) => b.type === "tool_use");
      const rawSkills =
        (toolBlock?.input as { skills?: Array<{ name: string; type: string }> } | undefined)
          ?.skills ?? [];

      const mentions = clampMentions(
        rawSkills
          .filter((s) => typeof s.name === "string" && s.name.length > 0)
          .map((s) => ({
            rawName: s.name,
            type: toSkillType(s.type),
            confidence: LLM_CONFIDENCE,
            source: "llm" as const,
          }))
      );

      await cache.set(key, mentions);
      return mentions;
    },
  };
}
