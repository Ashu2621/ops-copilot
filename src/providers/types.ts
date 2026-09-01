import type { ToolSchema } from "../tools/registry.js";

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ModelTurn {
  /** Raw provider content, echoed back on the next request unmodified. */
  raw: unknown;
  text: string;
  toolCalls: ToolCall[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";
  /** Populated only when stopReason === "refusal". */
  refusalCategory?: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface ToolResultMessage {
  toolUseId: string;
  content: string;
  isError: boolean;
}

/**
 * The seam between the agent loop and whatever produces model turns.
 *
 * This exists so the evaluation harness and CI can run the entire agent —
 * routing, tool dispatch, guardrails, approval, telemetry — with a scripted
 * provider and no API key. Without the seam, "run the evals" would mean
 * "have a billing account", which puts a scored regression suite out of reach
 * of exactly the contributor most likely to need it.
 */
export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  /** Cost in USD for a given token split; 0 for providers that cost nothing. */
  priceUsd(inputTokens: number, outputTokens: number): number;
  send(request: {
    system: string;
    tools: ToolSchema[];
    /** Conversation so far, in provider-native shape. */
    history: unknown[];
  }): Promise<ModelTurn>;
}
