/**
 * MCP server — exposes the copilot's tools over the Model Context Protocol.
 *
 * DESIGN NOTE — one registry, two transports.
 *
 * The agent loop reaches these tools through the Anthropic tool-use API. Any
 * other MCP-speaking client — Claude Desktop, an editor, another agent — reaches
 * the same four tools through this file. Crucially it is the *same registry*:
 * `TOOLS` is the single source of truth, so a tool added there is exposed on
 * both surfaces, described identically, and cannot drift between them.
 *
 * The guardrails come along for the ride, which is the whole point. An MCP
 * client gets the read-only connection, the row cap and the PII redactor, and
 * `issue_refund` is refused here rather than executed — an external client has
 * no approver attached, and "no human is watching" is exactly when a mutating
 * tool must not run. Re-implementing the tools for MCP would have meant
 * re-implementing the guarantees, and eventually forgetting one.
 *
 * The low-level `Server` is used rather than `McpServer` because `registerTool`
 * wants Zod schemas, and these tools already carry JSON Schema that the
 * Anthropic API consumes. Translating them would create a second definition to
 * keep in sync — the exact drift this design avoids.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DatabaseSync } from "../db/sqlite.js";
import { TOOLS, TOOLS_BY_NAME, type ToolContext } from "../tools/registry.js";
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
        ? `${t.description}\n\nNOTE: refused over MCP — this tool changes state and no approver is attached to an MCP session.`
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

    const readDb = new DatabaseSync(dbPath, { readOnly: true });
    const ctx: ToolContext = {
      readDb,
      writeDb: () => {
        throw new Error("Write access is not available over MCP.");
      },
    };

    try {
      const output = tool.run((args ?? {}) as Record<string, unknown>, ctx);
      const { value } = redactJson(output);
      return { content: [{ type: "text" as const, text: value }] };
    } catch (err) {
      const message =
        err instanceof SqlGuardError ? `${err.code}: ${err.message}` : (err as Error).message;
      return errorResult(message);
    } finally {
      readDb.close();
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
