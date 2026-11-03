import { immediate, type DatabaseSyncInstance as DatabaseSync } from "../db/sqlite.js";
import { assertSingleReadStatement, truncateRows, MAX_ROWS } from "../guardrails/sql.js";
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
  /** Mutating tools only run after an Approver says yes. See guardrails/approval.ts. */
  mutating: boolean;
  /** One line shown to the approver. Required for mutating tools. */
  summarise?: (input: Record<string, unknown>) => string;
  run: (input: Record<string, unknown>, ctx: ToolContext, auth?: Authorization) => unknown;
}

export interface ToolContext {
  /** Read-only handle for the fixed queries tools write themselves. */
  readDb: DatabaseSync;
  /** Model-written SQL goes here: read-only, row-capped, off the main thread. */
  sql: (query: string) => Promise<Record<string, unknown>[]>;
  writeDb: () => DatabaseSync;
}

/** Passed to a mutating tool once, for one specific approved call. */
export interface Authorization {
  approvedBy: string;
  /** Same key twice means same refund. The second call returns the first result. */
  idempotencyKey: string;
}

export class ToolInputError extends Error {}

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
    run: async (input, ctx) => {
      const sql = String(input.sql ?? "");
      assertSingleReadStatement(sql);
      const { rows, truncated } = truncateRows(await ctx.sql(sql));
      return { row_count: rows.length, truncated, rows };
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
      const hours = clampInt(input.hours, 1, 48, 24);
      // Bounded by time, not by row count, so the answer stays right if the
      // sampling interval ever changes.
      const rows = ctx.readDb
        .prepare(
          `SELECT value, recorded_at FROM service_metrics
           WHERE name = ?
             AND recorded_at > strftime('%Y-%m-%dT%H:%M:%fZ',
                   (SELECT MAX(recorded_at) FROM service_metrics WHERE name = ?), ?)
           ORDER BY recorded_at DESC`,
        )
        .all(metric, metric, `-${hours} hours`) as Array<{ value: number; recorded_at: string }>;

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
      const hits = searchRunbooks(String(input.query ?? ""), clampInt(input.top_k, 1, 5, 3));
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
      `Refund ${formatMoney(Number(input.amount_cents))} on order #${input.order_id} (${input.reason})`,
    run: (input, ctx, auth) => {
      if (!auth) throw new Error("issue_refund ran without an approval. This is a bug in the caller.");

      const orderId = Number(input.order_id);
      const amount = Number(input.amount_cents);
      if (!Number.isInteger(amount) || amount <= 0) {
        throw new ToolInputError("amount_cents must be a positive integer.");
      }

      const db = ctx.writeDb();
      return immediate(db, () => {
        const prior = db
          .prepare("SELECT id, order_id, amount_cents FROM refunds WHERE idempotency_key = ?")
          .get(auth.idempotencyKey) as { id: number; order_id: number; amount_cents: number } | undefined;
        if (prior) {
          return { refund_id: prior.id, order_id: prior.order_id, amount_cents: prior.amount_cents, replayed: true };
        }

        const order = db
          .prepare(
            `SELECT o.status, o.total_cents, COALESCE(SUM(r.amount_cents), 0) AS refunded
             FROM orders o LEFT JOIN refunds r ON r.order_id = o.id
             WHERE o.id = ? GROUP BY o.id`,
          )
          .get(orderId) as { status: string; total_cents: number; refunded: number } | undefined;

        if (!order) throw new ToolInputError(`Order #${orderId} does not exist.`);
        if (order.status !== "paid" && order.status !== "shipped") {
          throw new ToolInputError(`Order #${orderId} is ${order.status}; only paid or shipped orders can be refunded.`);
        }
        const remaining = order.total_cents - order.refunded;
        if (amount > remaining) {
          throw new ToolInputError(
            `Refund of ${formatMoney(amount)} exceeds the ${formatMoney(remaining)} still refundable on order #${orderId} ` +
              `(total ${formatMoney(order.total_cents)}, already refunded ${formatMoney(order.refunded)}).`,
          );
        }

        const row = db
          .prepare(
            `INSERT INTO refunds (order_id, amount_cents, reason, approved_by, idempotency_key, created_at)
             VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
          )
          .get(
            orderId,
            amount,
            String(input.reason ?? "unspecified").slice(0, 200),
            auth.approvedBy,
            auth.idempotencyKey,
            new Date().toISOString(),
          ) as { id: number };

        return { refund_id: row.id, order_id: orderId, amount_cents: amount, approved_by: auth.approvedBy };
      });
    },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export const toolSchemas = (): ToolSchema[] =>
  TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(value ?? fallback));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
