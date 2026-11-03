/**
 * The same tools over MCP, for Claude Desktop, editors or other agents.
 *
 * Reads the shared TOOLS registry, so a new tool shows up here automatically
 * with the same guardrails (read-only SQL, row cap, PII redaction).
 * issue_refund is refused: an MCP session has nobody to approve it.
 *
 * Uses the low-level Server instead of McpServer because registerTool wants
 * Zod schemas and the tools already have JSON Schema.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, TOOLS_BY_NAME } from "../tools/registry.js";
import { openToolContext } from "../tools/context.js";
import { redactJson } from "../guardrails/pii.js";
import { SqlGuardError } from "../guardrails/sql.js";
import { DB_PATH } from "../db/seed.js";

export const SERVER_INFO = { name: "ops-copilot", version: "1.0.0" };

export function buildServer(dbPath: string = DB_PATH): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.mutating
        ? `${t.description}\n\nNOTE: refused over MCP: this tool changes state and no approver is attached to an MCP session.`
        : t.description,
      inputSchema: t.input_schema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = TOOLS_BY_NAME.get(name);

    if (!tool) {
      return errorResult(`No tool named ${name}.`);
    }

    // An MCP session has no human on the other end of an approval prompt, so
    // the gate cannot be satisfied. Refuse rather than silently downgrading.
    if (tool.mutating) {
      return errorResult(
        `${name} changes production state and requires human approval, which an MCP session cannot provide. Use the HTTP API with an ops:approve token.`,
      );
    }

    const ctx = openToolContext(dbPath, { writable: false });
    try {
      const output = await tool.run((args ?? {}) as Record<string, unknown>, ctx);
      const { value } = redactJson(output);
      return { content: [{ type: "text" as const, text: value }] };
    } catch (err) {
      const message =
        err instanceof SqlGuardError ? `${err.code}: ${err.message}` : (err as Error).message;
      return errorResult(message);
    } finally {
      ctx.close();
    }
  });

  return server;
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export async function main(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}
