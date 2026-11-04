/**
 * The Gemini adapter against a fake endpoint: request shape, thought
 * signatures surviving a multi-step tool run, retries, refusals. Plus the
 * daily budget that sits in front of any provider on a public deployment.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/agent/loop.js";
import { GeminiProvider, GeminiError, toGeminiContents } from "../src/providers/gemini.js";
import { BudgetedProvider } from "../src/providers/budget.js";
import { MockProvider } from "../src/providers/mock.js";
import { NOW_MS } from "../src/db/seed.js";
import { freshDb } from "./fixture.js";

const DB = join(process.cwd(), "data", "test-gemini.db");
const NOW = new Date(NOW_MS).toISOString();

beforeAll(() => freshDb(DB));
afterAll(() => rmSync(DB, { force: true }));

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: {
    contents: Array<{ role: string; parts: Array<Record<string, any>> }>;
    tools: Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
    systemInstruction: unknown;
  };
}

/** A fetch that answers from a script and records what it was sent. */
function fakeGemini(replies: Array<{ status?: number; json: unknown }>) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const reply = replies.shift();
    if (!reply) throw new Error("fake Gemini ran out of replies");
    return new Response(JSON.stringify(reply.json), { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

const gemini = (fetchImpl: typeof fetch) =>
  new GeminiProvider({ apiKey: "test-key", model: "gemini-test", fetch: fetchImpl, sleep: async () => {} });

const usage = { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5 };

describe("Gemini adapter", () => {
  it("runs a tool and sends the thought signature and function name back", async () => {
    const { sent, fetchImpl } = fakeGemini([
      {
        json: {
          candidates: [
            {
              finishReason: "STOP",
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      id: "call-1",
                      name: "run_sql",
                      args: { sql: "SELECT failure_code, COUNT(*) AS n FROM payments WHERE status = 'failed' GROUP BY failure_code" },
                    },
                    thoughtSignature: "sig-abc",
                  },
                ],
              },
            },
          ],
          usageMetadata: usage,
        },
      },
      {
        json: {
          candidates: [
            { finishReason: "STOP", content: { role: "model", parts: [{ text: "Most failures are card_declined." }] } },
          ],
          usageMetadata: usage,
        },
      },
    ]);

    const r = await run({ question: "Break down the failure codes.", dbPath: DB, provider: gemini(fetchImpl), nowIso: NOW });

    expect(r.stoppedBecause).toBe("answered");
    expect(r.answer).toBe("Most failures are card_declined.");
    expect(r.toolsUsed).toEqual(["run_sql"]);
    expect(r.usage).toMatchObject({ inputTokens: 200, outputTokens: 50 });

    const first = sent[0]!;
    expect(first.url).toContain("/models/gemini-test:generateContent");
    expect(first.url).not.toContain("test-key");
    expect(first.headers["x-goog-api-key"]).toBe("test-key");
    expect(first.body.systemInstruction).toBeDefined();
    const run_sql = first.body.tools[0]!.functionDeclarations.find((d) => d.name === "run_sql")!;
    expect(run_sql.parametersJsonSchema).toMatchObject({ type: "object" });

    const [question, modelTurn, toolResult] = sent[1]!.body.contents;
    expect(question!.role).toBe("user");
    expect(modelTurn).toMatchObject({
      role: "model",
      parts: [{ functionCall: { id: "call-1", name: "run_sql" }, thoughtSignature: "sig-abc" }],
    });
    expect(toolResult!.role).toBe("user");
    expect(toolResult!.parts[0]!.functionResponse).toMatchObject({ id: "call-1", name: "run_sql" });
    expect(toolResult!.parts[0]!.functionResponse.response.result).toContain("card_declined");
  });

  it("gives calls without an id one, so results still pair up", async () => {
    const { fetchImpl } = fakeGemini([
      {
        json: {
          candidates: [{ content: { parts: [{ functionCall: { name: "search_runbook", args: { query: "timeouts" } } }] } }],
        },
      },
    ]);
    const turn = await gemini(fetchImpl).send({ system: "s", tools: [], history: [{ role: "user", content: "q" }] });
    expect(turn.stopReason).toBe("tool_use");
    expect(turn.toolCalls[0]!.id).toBe("gemini-call-0");
  });

  it("retries 429 and 503, then gives up with the API's message", async () => {
    const busy = { status: 429, json: { error: { message: "Resource exhausted" } } };
    const ok = { json: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "fine" }] } }] } };

    const retried = fakeGemini([busy, { status: 503, json: {} }, ok]);
    const turn = await gemini(retried.fetchImpl).send({ system: "s", tools: [], history: [{ role: "user", content: "q" }] });
    expect(turn.text).toBe("fine");
    expect(retried.sent).toHaveLength(3);

    const exhausted = fakeGemini([busy, busy, busy]);
    await expect(
      gemini(exhausted.fetchImpl).send({ system: "s", tools: [], history: [{ role: "user", content: "q" }] }),
    ).rejects.toThrow(/429: Resource exhausted/);
  });

  it("does not retry a bad request", async () => {
    const { sent, fetchImpl } = fakeGemini([{ status: 400, json: { error: { message: "API key not valid" } } }]);
    const err = await gemini(fetchImpl)
      .send({ system: "s", tools: [], history: [{ role: "user", content: "q" }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GeminiError);
    expect((err as GeminiError).status).toBe(400);
    expect(sent).toHaveLength(1);
  });

  it("reports a blocked prompt or a safety stop as a refusal", async () => {
    const { fetchImpl } = fakeGemini([
      { json: { promptFeedback: { blockReason: "PROHIBITED_CONTENT" } } },
      { json: { candidates: [{ finishReason: "SAFETY" }] } },
    ]);
    const provider = gemini(fetchImpl);
    const request = { system: "s", tools: [], history: [{ role: "user", content: "q" }] };
    expect(await provider.send(request)).toMatchObject({ stopReason: "refusal", refusalCategory: "prohibited_content" });
    expect(await provider.send(request)).toMatchObject({ stopReason: "refusal", refusalCategory: "safety" });
  });

  it("marks failed tool results as errors in the function response", () => {
    const contents = toGeminiContents([
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "run_sql", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "write refused", is_error: true }] },
    ]);
    expect(contents[2]!.parts[0]!.functionResponse).toEqual({
      id: "c1",
      name: "run_sql",
      response: { error: "write refused" },
    });
  });

  it("refuses to start without a key", () => {
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      expect(() => new GeminiProvider()).toThrow(/GEMINI_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    }
  });
});

describe("daily model budget", () => {
  it("stops model calls at the cap, keeps router answers, and resets the next UTC day", async () => {
    let clock = Date.parse("2026-11-04T23:00:00Z");
    const provider = new BudgetedProvider(new MockProvider(), 2, () => clock);
    const ask = (question: string) => run({ question, dbPath: DB, provider, nowIso: NOW });

    const first = await ask("Give me the failure code breakdown.");
    expect(first.stoppedBecause).toBe("answered");

    const capped = await ask("Give me the failure code breakdown.");
    expect(capped.stoppedBecause).toBe("budget");
    expect(capped.answer).toMatch(/model budget \(2 calls\) is used up/);

    const routed = await ask("How many payments failed in the last hour?");
    expect(routed.path).toBe("router");
    expect(routed.stoppedBecause).toBe("answered");

    clock = Date.parse("2026-11-05T00:00:01Z");
    expect((await ask("Give me the failure code breakdown.")).stoppedBecause).toBe("answered");
  });
});
