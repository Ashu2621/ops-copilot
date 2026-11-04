import type { ModelProvider, ModelTurn, ToolCall } from "./types.js";
import type { ToolSchema } from "../tools/registry.js";

/**
 * Gemini behind the same ModelProvider interface, over the REST API with
 * plain fetch. No SDK: the surface we need is one endpoint, and the SDKs move
 * faster than this adapter does.
 *
 * History stays in the canonical (Anthropic) shape like every other adapter,
 * with two Gemini-specific details carried along inside it:
 *
 *  - thought signatures. Gemini 3 models attach an opaque `thoughtSignature`
 *    to parts of a turn and expect it back, byte for byte, on the next request.
 *    Drop it and a multi-step tool run fails with MISSING_THOUGHT_SIGNATURE.
 *    It rides on the canonical block as `thought_signature`.
 *  - function names on results. Gemini matches a functionResponse to its call
 *    by name, and a canonical tool_result only has the call id, so names are
 *    looked up from the assistant turn that made the call.
 */

/**
 * USD per million tokens. Empty on purpose: the demo runs on the free tier,
 * and a guessed price is worse than none. Add the list price for the model
 * before trusting a cost number or the per-question budget with this provider.
 */
const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {};

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Retries for 429/500/503, which Gemini returns under load more often than most. */
const RETRY_DELAYS_MS = [1_000, 3_000];

export interface GeminiProviderOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  fetch?: typeof fetch;
  /** Injected so tests don't sleep through the backoff. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class GeminiProvider implements ModelProvider {
  readonly name = "gemini";
  readonly model: string;

  private readonly apiKey: string;
  private readonly maxTokens: number;
  private readonly fetch: typeof fetch;
  private readonly sleep: NonNullable<GeminiProviderOptions["sleep"]>;

  constructor(opts: GeminiProviderOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not set. Use --provider mock to run without a key.");
    }
    this.apiKey = apiKey;
    this.model = opts.model ?? process.env.OPS_COPILOT_GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
    this.maxTokens = opts.maxTokens ?? 4_096;
    this.fetch = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? sleep;
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
    signal,
  }: {
    system: string;
    tools: ToolSchema[];
    history: unknown[];
    signal?: AbortSignal;
  }): Promise<ModelTurn> {
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: toGeminiContents(history),
      tools: [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            // Full JSON Schema, so the tool definitions don't have to be
            // rewritten into Gemini's OpenAPI subset.
            parametersJsonSchema: t.input_schema,
          })),
        },
      ],
      generationConfig: { maxOutputTokens: this.maxTokens },
    });

    const response = await this.post(body, signal);
    return fromGeminiResponse(response);
  }

  private async post(body: string, signal?: AbortSignal): Promise<GeminiResponse> {
    const url = `${API_BASE}/models/${encodeURIComponent(this.model)}:generateContent`;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(url, {
        method: "POST",
        // The key goes in a header, never the query string, so it stays out of
        // proxy and access logs.
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body,
        signal,
      });
      if (res.ok) return (await res.json()) as GeminiResponse;

      const retryable = res.status === 429 || res.status === 500 || res.status === 503;
      const delay = RETRY_DELAYS_MS[attempt];
      if (!retryable || delay === undefined) {
        throw new GeminiError(`Gemini returned ${res.status}: ${await errorMessage(res)}`, res.status);
      }
      await res.body?.cancel();
      await this.sleep(delay, signal);
    }
  }
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

const REFUSAL_REASONS = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"]);

export function fromGeminiResponse(response: GeminiResponse): ModelTurn {
  const usage = {
    inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
    // Thinking tokens are billed as output, so they count as output here too.
    outputTokens:
      (response.usageMetadata?.candidatesTokenCount ?? 0) + (response.usageMetadata?.thoughtsTokenCount ?? 0),
  };

  // A blocked prompt comes back as 200 with no candidates at all.
  const blocked = response.promptFeedback?.blockReason;
  if (blocked) {
    return { raw: [], text: "", toolCalls: [], stopReason: "refusal", refusalCategory: blocked.toLowerCase(), usage };
  }

  const candidate = response.candidates?.[0];
  const finish = candidate?.finishReason ?? "";
  if (REFUSAL_REASONS.has(finish)) {
    return { raw: [], text: "", toolCalls: [], stopReason: "refusal", refusalCategory: finish.toLowerCase(), usage };
  }

  const blocks: Array<Record<string, unknown>> = [];
  const toolCalls: ToolCall[] = [];
  const texts: string[] = [];

  for (const [i, part] of (candidate?.content?.parts ?? []).entries()) {
    const signature = part.thoughtSignature ? { thought_signature: part.thoughtSignature } : {};
    if (part.functionCall) {
      const call: ToolCall = {
        // Older models leave the id out. The loop needs one to pair results with calls.
        id: part.functionCall.id ?? `gemini-call-${i}`,
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
      };
      toolCalls.push(call);
      blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.input, ...signature });
    } else if (typeof part.text === "string" && !part.thought) {
      texts.push(part.text);
      blocks.push({ type: "text", text: part.text, ...signature });
    } else if (part.thoughtSignature) {
      // An empty part that only carries a signature still has to go back.
      blocks.push({ type: "text", text: "", ...signature });
    }
  }

  const stopReason: ModelTurn["stopReason"] =
    toolCalls.length > 0
      ? "tool_use"
      : finish === "MAX_TOKENS"
        ? "max_tokens"
        : finish === "STOP"
          ? "end_turn"
          : "other";

  return { raw: blocks, text: texts.join("").trim(), toolCalls, stopReason, usage };
}

/** Translate the canonical Anthropic-shaped transcript into Gemini contents. */
export function toGeminiContents(history: unknown[]): GeminiContent[] {
  const out: GeminiContent[] = [];
  const callNames = new Map<string, string>();

  for (const entry of history as Array<{ role: string; content: unknown }>) {
    if (entry.role === "user" && typeof entry.content === "string") {
      out.push({ role: "user", parts: [{ text: entry.content }] });
      continue;
    }

    const blocks = Array.isArray(entry.content) ? (entry.content as Array<Record<string, unknown>>) : [];

    if (entry.role === "assistant") {
      const parts: GeminiPart[] = [];
      for (const b of blocks) {
        const signature = typeof b.thought_signature === "string" ? { thoughtSignature: b.thought_signature } : {};
        if (b.type === "tool_use") {
          callNames.set(String(b.id), String(b.name));
          parts.push({
            functionCall: { id: String(b.id), name: String(b.name), args: (b.input ?? {}) as Record<string, unknown> },
            ...signature,
          });
        } else if (b.type === "text") {
          parts.push({ text: String(b.text ?? ""), ...signature });
        }
      }
      if (parts.length > 0) out.push({ role: "model", parts });
      continue;
    }

    const parts: GeminiPart[] = [];
    for (const b of blocks) {
      if (b.type !== "tool_result") continue;
      const id = String(b.tool_use_id);
      const content = String(b.content ?? "");
      parts.push({
        functionResponse: {
          id,
          name: callNames.get(id) ?? "unknown",
          // Gemini wants an object here. Tool output is already JSON text, so
          // it goes in as one field rather than being parsed and re-shaped.
          response: b.is_error ? { error: content } : { result: content },
        },
      });
    }
    if (parts.length > 0) out.push({ role: "user", parts });
  }

  return out;
}

async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const message = (JSON.parse(text) as { error?: { message?: string } }).error?.message;
    if (message) return message;
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return text.slice(0, 200) || res.statusText;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
