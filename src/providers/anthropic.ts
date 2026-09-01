import Anthropic from "@anthropic-ai/sdk";
import type { ModelProvider, ModelTurn, ToolCall } from "./types.js";

/**
 * Published list prices in USD per million tokens.
 * Kept explicit rather than fetched, so cost reporting is reproducible offline
 * and a stale entry shows up as a wrong number rather than a silent zero.
 */
const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export const DEFAULT_MODEL = "claude-opus-5";

export interface AnthropicProviderOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  /**
   * Thinking depth / token spend. Left unset the API uses `high`.
   * Exposed because it is the cleanest single knob for trading accuracy
   * against cost and latency, and the eval harness reports all three.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  readonly model: string;

  private readonly client: Anthropic;
  private readonly maxTokens: number;
  private readonly effort?: AnthropicProviderOptions["effort"];

  constructor(opts: AnthropicProviderOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Use --provider mock to run without an API key.",
      );
    }
    this.client = new Anthropic({ apiKey });
    this.model = opts.model ?? process.env.OPS_COPILOT_MODEL ?? DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens ?? 16_000;
    this.effort = opts.effort;
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
    tools: Array<{ name: string; description: string; input_schema: unknown }>;
    history: unknown[];
  }): Promise<ModelTurn> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      // Adaptive thinking is the default on this model family; stated
      // explicitly so the intent survives a future model swap.
      thinking: { type: "adaptive" },
      ...(this.effort ? { output_config: { effort: this.effort } } : {}),
      tools: tools as Anthropic.Tool[],
      messages: history as Anthropic.MessageParam[],
    });

    // A refusal returns HTTP 200 with no usable content — check before reading.
    if (response.stop_reason === "refusal") {
      return {
        raw: response.content,
        text: "",
        toolCalls: [],
        stopReason: "refusal",
        refusalCategory: response.stop_details?.category ?? undefined,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    const toolCalls: ToolCall[] = response.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({
        id: b.id,
        name: b.name,
        // Tool inputs arrive as parsed JSON; never string-match the raw form.
        input: (b.input ?? {}) as Record<string, unknown>,
      }));

    const stopReason: ModelTurn["stopReason"] =
      response.stop_reason === "end_turn"
        ? "end_turn"
        : response.stop_reason === "tool_use"
          ? "tool_use"
          : response.stop_reason === "max_tokens"
            ? "max_tokens"
            : "other";

    return {
      raw: response.content,
      text,
      toolCalls,
      stopReason,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
