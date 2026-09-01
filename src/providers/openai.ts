import OpenAI from "openai";
import type { ModelProvider, ModelTurn, ToolCall } from "./types.js";
import type { ToolSchema } from "../tools/registry.js";

/**
 * Second vendor behind the same `ModelProvider` seam.
 *
 * DESIGN NOTE — why this exists, and what it cost.
 *
 * The seam was introduced so the eval harness could run offline. This provider
 * is the test of whether it was a real abstraction or just a mock-shaped hole:
 * the agent loop, every guardrail, the router and the whole eval suite work
 * against it unchanged. It also makes the cost/latency/accuracy comparison in
 * the harness a cross-vendor one rather than a single-vendor curiosity.
 *
 * The honest cost: conversation history is stored in Anthropic's shape, because
 * Anthropic was the first provider and picking a "neutral" format on day one
 * would have been speculative. So this adapter translates on every send —
 * assistant content blocks become `tool_calls`, and each `tool_result` block
 * becomes its own `role: "tool"` message, which is the shape OpenAI expects.
 *
 * With two providers, translating in one adapter is cheaper than introducing a
 * third internal format that both must convert to. If a third vendor arrives,
 * that trade flips and the neutral shape becomes worth building.
 */

/**
 * Published list prices, USD per million tokens. Same rule as the Anthropic
 * table: kept explicit so cost reporting is reproducible offline, and so a
 * stale entry surfaces as a wrong number rather than a silent zero. Verify
 * against the vendor's pricing page before trusting a cost comparison.
 */
const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
};

export const DEFAULT_OPENAI_MODEL = "gpt-4o";

export interface OpenAIProviderOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
}

export class OpenAIProvider implements ModelProvider {
  readonly name = "openai";
  readonly model: string;

  private readonly client: OpenAI;
  private readonly maxTokens: number;

  constructor(opts: OpenAIProviderOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not set. Use --provider mock to run without a key.");
    }
    this.client = new OpenAI({ apiKey });
    this.model = opts.model ?? process.env.OPS_COPILOT_OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
    this.maxTokens = opts.maxTokens ?? 4_096;
  }

  priceUsd(inputTokens: number, outputTokens: number): number {
    const price = PRICE_PER_MTOK[this.model];
    if (!price) return 0;
    return (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output;
  }

  async send({
    system,
    tools,
    history,
  }: {
    system: string;
    tools: ToolSchema[];
    history: unknown[];
  }): Promise<ModelTurn> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [{ role: "system", content: system }, ...toOpenAIMessages(history)],
      tools: tools.map((t) => ({
        type: "function" as const,
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      })),
    });

    const choice = response.choices[0];
    const message = choice?.message;

    const toolCalls: ToolCall[] = (message?.tool_calls ?? [])
      .filter((c): c is typeof c & { type: "function" } => c.type === "function")
      .map((c) => ({
        id: c.id,
        name: c.function.name,
        // Arguments arrive as a JSON *string* here, unlike Anthropic's parsed
        // object. A malformed payload must surface as a tool error the model
        // can recover from, not crash the run.
        input: safeParse(c.function.arguments),
      }));

    const stopReason: ModelTurn["stopReason"] =
      choice?.finish_reason === "tool_calls"
        ? "tool_use"
        : choice?.finish_reason === "length"
          ? "max_tokens"
          : choice?.finish_reason === "content_filter"
            ? "refusal"
            : "end_turn";

    return {
      // Stored in the canonical (Anthropic) shape so the loop and any later
      // provider see one consistent transcript.
      raw: toAnthropicContent(message?.content ?? "", toolCalls),
      text: (message?.content ?? "").trim(),
      toolCalls,
      stopReason,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }
}

type OpenAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** Translate the canonical Anthropic-shaped transcript into OpenAI's format. */
export function toOpenAIMessages(history: unknown[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];

  for (const entry of history as Array<{ role: string; content: unknown }>) {
    if (entry.role === "user" && typeof entry.content === "string") {
      out.push({ role: "user", content: entry.content });
      continue;
    }

    const blocks = Array.isArray(entry.content)
      ? (entry.content as Array<Record<string, unknown>>)
      : [];

    if (entry.role === "assistant") {
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => String(b.text ?? ""))
        .join("\n");
      const calls = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          id: String(b.id),
          type: "function" as const,
          function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) },
        }));

      out.push({
        role: "assistant",
        content: text || null,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      } as OpenAIMessage);
      continue;
    }

    // A single Anthropic user turn can carry several tool_result blocks;
    // OpenAI wants one `tool` message per result.
    for (const block of blocks) {
      if (block.type !== "tool_result") continue;
      out.push({
        role: "tool",
        tool_call_id: String(block.tool_use_id),
        content: String(block.content ?? ""),
      });
    }
  }

  return out;
}

function toAnthropicContent(text: string, toolCalls: ToolCall[]): unknown[] {
  const blocks: unknown[] = [];
  if (text) blocks.push({ type: "text", text });
  for (const c of toolCalls) {
    blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
  }
  return blocks;
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
