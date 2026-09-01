/**
 * Deterministic-first routing.
 *
 * DESIGN NOTE — the point of this file.
 *
 * A large share of real on-call traffic is not open-ended reasoning. It is the
 * same dozen questions asked over and over: how many payments failed, what is
 * p95 right now, how many orders are stuck pending. Those have exactly one
 * correct answer, computable by one query, and routing them through a language
 * model buys nothing while adding three costs — money per call, a second of
 * latency, and a non-zero chance the model paraphrases the number wrong.
 *
 * So known intents are matched here and answered directly from SQL. The model is
 * reserved for what it is actually good at: questions nobody anticipated, and
 * questions that need several tools composed together.
 *
 * The escalation rate this produces is reported by the eval harness, because it
 * is the number that tells you whether the routing layer is earning its keep.
 * If it ever approaches 100%, this file should be deleted rather than defended.
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
