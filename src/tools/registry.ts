import type { DatabaseSyncInstance as DatabaseSync } from "../db/sqlite.js";
import { assertSingleReadStatement, truncateRows, SqlGuardError, MAX_ROWS } from "../guardrails/sql.js";
import { searchRunbooks } from "../rag/retrieve.js";

/** JSON Schema as accepted by the Anthropic tool-use API. */
export interface ToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolDefinition extends ToolSchema {
  /**
   * Whether this tool changes state. Mutating tools never execute directly —
   * the agent loop suspends them for human approval. See guardrails/approval.ts.
   */
  mutating: boolean;
  /** Summary shown to a human approver; only required for mutating tools. */
  summarise?: (input: Record<string, unknown>) => string;
  run: (input: Record<string, unknown>, ctx: ToolContext) => unknown;
}

export interface ToolContext {
  /** Opened with readOnly: true — the authoritative read-only guarantee. */
  readDb: DatabaseSync;
  /** Only handed to mutating tools, and only after approval. */
  writeDb: () => DatabaseSync;
  approvedBy?: string;
}

export const SCHEMA_DESCRIPTION = `
customers(id, name, email, phone, tier['free'|'pro'|'enterprise'], created_at)
orders(id, customer_id -> customers.id, status['pending'|'paid'|'shipped'|'cancelled'], total_cents, created_at)
payments(id, order_id -> orders.id, status['succeeded'|'failed'|'pending'], amount_cents, failure_code, created_at)
refunds(id, order_id -> orders.id, amount_cents, reason, approved_by, created_at)
service_metrics(id, name, value, recorded_at)

All timestamps are ISO-8601 UTC strings. Money is in integer cents.
Metric names: 'checkout_p95_latency_ms', 'payment_error_rate', 'orders_per_minute'.
`.trim();

export const TOOLS: ToolDefinition[] = [
  {
    name: "run_sql",
    mutating: false,
    description:
      `Run a single read-only SQL query against the operational database and return up to ${MAX_ROWS} rows. ` +
      `Only SELECT (or WITH ... SELECT) is permitted; the connection is physically read-only. ` +
      `Prefer aggregates over fetching raw rows.\n\nSchema:\n${SCHEMA_DESCRIPTION}`,
    input_schema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "A single SELECT statement. No trailing semicolon needed." },
      },
      required: ["sql"],
    },
    run: (input, ctx) => {
      const sql = String(input.sql ?? "");
      assertSingleReadStatement(sql);
      try {
        const all = ctx.readDb.prepare(sql).all();
        const { rows, truncated } = truncateRows(all);
        return { row_count: all.length, truncated, rows };
      } catch (err) {
        if (err instanceof SqlGuardError) throw err;
        throw new SqlGuardError(
          `Query rejected by the database: ${(err as Error).message}`,
          "engine_rejected",
        );
      }
    },
  },

  {
    name: "get_metric_series",
    mutating: false,
    description:
      "Return the recorded time series for one service metric, newest first. " +
      "Use this for latency, error-rate and throughput questions instead of writing SQL.",
    input_schema: {
      type: "object",
      properties: {
        metric: {
          type: "string",
          enum: ["checkout_p95_latency_ms", "payment_error_rate", "orders_per_minute"],
        },
        hours: {
          type: "integer",
          description: "How many hours back to return (1-48).",
        },
      },
      required: ["metric"],
    },
    run: (input, ctx) => {
      const metric = String(input.metric ?? "");
      const hours = Math.min(48, Math.max(1, Number(input.hours ?? 24)));
      const rows = ctx.readDb
        .prepare(
          `SELECT value, recorded_at FROM service_metrics
           WHERE name = ? ORDER BY recorded_at DESC LIMIT ?`,
        )
        .all(metric, hours) as Array<{ value: number; recorded_at: string }>;

      if (rows.length === 0) return { metric, samples: [], note: "Unknown metric name." };

      const values = rows.map((x) => x.value);
      return {
        metric,
        samples: rows,
        summary: {
          latest: values[0],
          min: Math.min(...values),
          max: Math.max(...values),
          mean: Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(4)),
        },
      };
    },
  },

  {
    name: "search_runbook",
    mutating: false,
    description:
      "Search the on-call runbooks for remediation guidance. Use this for 'what should I do about X' " +
      "questions. Returns the most relevant runbook sections with their source file.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language description of the problem." },
        top_k: { type: "integer", description: "How many sections to return (default 3)." },
      },
      required: ["query"],
    },
    run: (input) => {
      const hits = searchRunbooks(String(input.query ?? ""), Number(input.top_k ?? 3));
      return { matches: hits };
    },
  },

  {
    name: "issue_refund",
    mutating: true,
    description:
      "Issue a refund against an order. This changes production state and always requires " +
      "explicit human approval before it runs.",
    input_schema: {
      type: "object",
      properties: {
        order_id: { type: "integer" },
        amount_cents: { type: "integer" },
        reason: { type: "string" },
      },
      required: ["order_id", "amount_cents", "reason"],
    },
    summarise: (input) =>
      `Refund ${formatMoney(Number(input.amount_cents))} on order #${input.order_id} — ${input.reason}`,
    run: (input, ctx) => {
      const db = ctx.writeDb();
      const orderId = Number(input.order_id);
      const order = db.prepare("SELECT id, total_cents FROM orders WHERE id = ?").get(orderId) as
        | { id: number; total_cents: number }
        | undefined;

      if (!order) throw new Error(`Order #${orderId} does not exist.`);

      const amount = Number(input.amount_cents);
      if (!Number.isInteger(amount) || amount <= 0) {
        throw new Error("amount_cents must be a positive integer.");
      }
      if (amount > order.total_cents) {
        throw new Error(
          `Refund of ${formatMoney(amount)} exceeds order total ${formatMoney(order.total_cents)}.`,
        );
      }

      const nextId =
        ((db.prepare("SELECT MAX(id) AS m FROM refunds").get() as { m: number | null }).m ?? 0) + 1;
      db.prepare(
        `INSERT INTO refunds (id, order_id, amount_cents, reason, approved_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        nextId,
        orderId,
        amount,
        String(input.reason ?? "unspecified"),
        ctx.approvedBy ?? "unknown",
        new Date().toISOString(),
      );

      return { refund_id: nextId, order_id: orderId, amount_cents: amount, approved_by: ctx.approvedBy };
    },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export const toolSchemas = (): ToolSchema[] =>
  TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));

function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
