/**
 * Answers the common on-call questions straight from SQL.
 *
 * "How many payments failed in the last hour" has one right answer and one
 * query. Sending it to a model costs money and latency and risks a misquoted
 * number. Anything not matched here goes to the model. The eval prints the
 * escalation rate; if it gets close to 100%, delete this file.
 */
import type { DatabaseSyncInstance as DatabaseSync } from "../db/sqlite.js";

export interface DirectAnswer {
  kind: "direct";
  answer: string;
  intent: string;
  sql: string;
}

export interface Escalation {
  kind: "escalate";
  reason: string;
}

export type RouteResult = DirectAnswer | Escalation;

interface Intent {
  name: string;
  /** All patterns must match for the intent to fire. */
  match: RegExp[];
  sql: string;
  render: (row: Record<string, unknown>) => string;
}

const INTENTS: Intent[] = [
  {
    name: "failed_payments_last_hour",
    match: [/\bfail(ed|ure|ing)?\b/i, /\bpayments?\b/i, /\b(last|past|previous)\s+hour\b/i],
    sql: `SELECT COUNT(*) AS n FROM payments
          WHERE status = 'failed'
            AND recorded_within_hour(created_at)`,
    render: (row) => `${row.n} payment(s) failed in the last hour.`,
  },
  {
    name: "failed_payments_total",
    match: [/\bfail(ed|ure|ing)?\b/i, /\bpayments?\b/i, /\b(how many|count|total)\b/i],
    sql: `SELECT COUNT(*) AS n FROM payments WHERE status = 'failed'`,
    render: (row) => `${row.n} payment(s) have failed in total.`,
  },
  {
    name: "pending_orders",
    match: [/\bpending\b/i, /\borders?\b/i],
    sql: `SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'`,
    render: (row) => `${row.n} order(s) are currently pending.`,
  },
  {
    name: "current_p95_latency",
    match: [/\b(p95|latency)\b/i, /\b(current|now|latest|right now)\b/i],
    sql: `SELECT value FROM service_metrics
          WHERE name = 'checkout_p95_latency_ms'
          ORDER BY recorded_at DESC LIMIT 1`,
    render: (row) => `Checkout p95 latency is currently ${row.value} ms.`,
  },
  {
    name: "total_refund_amount",
    match: [/\brefund(s|ed)?\b/i, /\b(total|sum|how much)\b/i],
    sql: `SELECT COALESCE(SUM(amount_cents), 0) AS cents, COUNT(*) AS n FROM refunds`,
    render: (row) =>
      `${row.n} refund(s) totalling $${(Number(row.cents) / 100).toFixed(2)} have been issued.`,
  },
];

/**
 * `recorded_within_hour` is a placeholder the router expands before execution,
 * so intent SQL stays readable and the time anchor lives in exactly one place.
 */
function expand(sql: string, nowIso: string): string {
  return sql.replace(
    /recorded_within_hour\((\w+)\)/g,
    (_m, col) => `${col} >= datetime('${nowIso}', '-1 hour')`,
  );
}

export function route(question: string, db: DatabaseSync, nowIso: string): RouteResult {
  for (const intent of INTENTS) {
    if (!intent.match.every((re) => re.test(question))) continue;

    const sql = expand(intent.sql, nowIso);
    const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
    if (!row) return { kind: "escalate", reason: `Intent ${intent.name} returned no row.` };

    return { kind: "direct", intent: intent.name, sql, answer: intent.render(row) };
  }

  return { kind: "escalate", reason: "No deterministic intent matched." };
}

export const KNOWN_INTENTS = INTENTS.map((i) => i.name);
