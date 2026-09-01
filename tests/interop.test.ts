import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { toOpenAIMessages } from "../src/providers/openai.js";
import { buildServer, SERVER_INFO } from "../src/mcp/server.js";
import { TOOLS } from "../src/tools/registry.js";
import { freshDb } from "./fixture.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const DB = join(process.cwd(), "data", "test-interop.db");

beforeAll(() => freshDb(DB));
afterAll(() => rmSync(DB, { force: true }));

describe("OpenAI adapter — proving the provider seam is real", () => {
  it("passes a plain user turn through", () => {
    expect(toOpenAIMessages([{ role: "user", content: "how many orders?" }])).toEqual([
      { role: "user", content: "how many orders?" },
    ]);
  });

  it("converts Anthropic tool_use blocks into OpenAI tool_calls", () => {
    const out = toOpenAIMessages([
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          { type: "tool_use", id: "t1", name: "run_sql", input: { sql: "SELECT 1" } },
        ],
      },
    ]);

    expect(out[1]).toMatchObject({
      role: "assistant",
      content: "checking",
      tool_calls: [
        { id: "t1", type: "function", function: { name: "run_sql" } },
      ],
    });
    // Arguments cross the wire as a JSON string in OpenAI's format.
    const call = (out[1] as { tool_calls: Array<{ function: { arguments: string } }> }).tool_calls[0]!;
    expect(JSON.parse(call.function.arguments)).toEqual({ sql: "SELECT 1" });
  });

  it("fans several tool_result blocks out into one tool message each", () => {
    // The shape mismatch that makes the adapter necessary: Anthropic carries
    // parallel results in a single user turn, OpenAI wants one message apiece.
    const out = toOpenAIMessages([
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "run_sql", input: {} },
          { type: "tool_use", id: "t2", name: "search_runbook", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "rows" },
          { type: "tool_result", tool_use_id: "t2", content: "guidance" },
        ],
      },
    ]);

    const toolMessages = out.filter((m) => (m as { role: string }).role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]).toEqual({ role: "tool", tool_call_id: "t1", content: "rows" });
    expect(toolMessages[1]).toEqual({ role: "tool", tool_call_id: "t2", content: "guidance" });
  });

  it("emits null content for a tool-only assistant turn", () => {
    const out = toOpenAIMessages([
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "run_sql", input: {} }] },
    ]);
    expect((out[0] as { content: unknown }).content).toBeNull();
  });
});

describe("MCP server — same registry, same guardrails", () => {
  /** Reach the handlers the way the transport would, without a live socket. */
  function handlers(dbPath: string) {
    const server = buildServer(dbPath);
    const map = (server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers;
    return {
      list: () => map.get("tools/list")!({ method: "tools/list", params: {} }, {}),
      call: (name: string, args: Record<string, unknown>) =>
        map.get("tools/call")!(
          { method: "tools/call", params: { name, arguments: args } },
          {},
        ),
    };
  }

  it("advertises every tool from the shared registry", async () => {
    const { list } = handlers(DB);
    const result = (await list()) as { tools: Array<{ name: string; inputSchema: unknown }> };

    expect(result.tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    // Same JSON Schema object the Anthropic API receives — one definition.
    expect(result.tools.find((t) => t.name === "run_sql")!.inputSchema).toBe(
      TOOLS.find((t) => t.name === "run_sql")!.input_schema,
    );
  });

  it("serves a read tool", async () => {
    const { call } = handlers(DB);
    const result = (await call("run_sql", { sql: "SELECT COUNT(*) AS n FROM orders" })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text).rows[0].n).toBe(300);
  });

  it("carries the SQL guardrail onto the MCP surface", async () => {
    const { call } = handlers(DB);
    const result = (await call("run_sql", { sql: "DROP TABLE orders" })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not_a_read");
  });

  it("refuses the mutating tool — an MCP session has no approver", async () => {
    const { call } = handlers(DB);
    const result = (await call("issue_refund", {
      order_id: 12,
      amount_cents: 100,
      reason: "test",
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/human approval/i);
  });

  it("redacts PII on the MCP surface too", async () => {
    const { call } = handlers(DB);
    const result = (await call("run_sql", { sql: "SELECT name, email FROM customers LIMIT 3" })) as {
      content: Array<{ text: string }>;
    };
    expect(result.content[0]!.text).not.toMatch(/@example\.com/);
    expect(result.content[0]!.text).toContain("[EMAIL_");
  });

  it("reports a stable server identity", () => {
    expect(SERVER_INFO.name).toBe("ops-copilot");
  });
});
