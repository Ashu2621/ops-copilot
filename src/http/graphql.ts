/**
 * Read-only GraphQL over alerts, triage jobs and the refund audit trail.
 *
 * No mutations: state changes only go through the approval flow. Clients
 * decide how expensive a GraphQL query is, so list limits are clamped
 * server-side and query depth is capped. Resolvers use a read-only connection.
 */
import { buildSchema, graphql, parse, validate, specifiedRules, type GraphQLSchema } from "graphql";
import type { DatabaseSyncInstance } from "../db/sqlite.js";
import { redact } from "../guardrails/pii.js";

export const MAX_LIMIT = 100;
export const MAX_DEPTH = 8;

export const typeDefs = /* GraphQL */ `
  enum Severity {
    info
    warning
    critical
  }

  enum JobStatus {
    queued
    in_flight
    done
    dead
  }

  type Alert {
    id: ID!
    source: String!
    name: String!
    severity: Severity!
    receivedAt: String!
    "The triage job created for this alert, if one still exists."
    job: Job
  }

  type Job {
    id: Int!
    kind: String!
    status: JobStatus!
    attempts: Int!
    maxAttempts: Int!
    lastError: String
    "Agent output, present once the job has completed."
    answer: String
    costUsd: Float
    latencyMs: Int
  }

  type QueueStats {
    queued: Int!
    inFlight: Int!
    done: Int!
    dead: Int!
  }

  "A refund that was actually issued, and who approved it."
  type RefundAudit {
    id: Int!
    orderId: Int!
    amountCents: Int!
    reason: String!
    approvedBy: String!
    createdAt: String!
  }

  type Query {
    alerts(limit: Int = 20, severity: Severity): [Alert!]!
    alert(id: ID!): Alert
    jobs(limit: Int = 20, status: JobStatus): [Job!]!
    queueStats: QueueStats!
    auditTrail(limit: Int = 20): [RefundAudit!]!
  }
`;

let schemaCache: GraphQLSchema | null = null;
export function schema(): GraphQLSchema {
  schemaCache ??= buildSchema(typeDefs);
  return schemaCache;
}

const clamp = (n: unknown): number => Math.min(MAX_LIMIT, Math.max(1, Number(n) || 20));

interface JobRow {
  id: number;
  kind: string;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  result: string | null;
  payload: string;
}

function mapJob(row: JobRow) {
  let parsed: { answer?: string; costUsd?: number; latencyMs?: number } = {};
  if (row.result) {
    try {
      parsed = JSON.parse(row.result);
    } catch {
      /* a malformed result must not take down the query */
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    // Answers can quote rows the agent read, so they pass the redactor again
    // on the way out. Defence in depth: the tool results were already redacted.
    answer: parsed.answer ? redact(parsed.answer).text : null,
    costUsd: parsed.costUsd ?? null,
    latencyMs: parsed.latencyMs ?? null,
  };
}

export function rootValue(db: DatabaseSyncInstance) {
  const jobForAlert = (alertId: string) => {
    const row = db
      .prepare(
        `SELECT id, kind, status, attempts, max_attempts, last_error, result, payload
           FROM jobs WHERE json_extract(payload, '$.alertId') = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(alertId) as JobRow | undefined;
    return row ? mapJob(row) : null;
  };

  return {
    alerts: ({ limit, severity }: { limit?: number; severity?: string }) => {
      const rows = severity
        ? (db
            .prepare(
              `SELECT id, source, name, severity, received_at FROM alerts
                WHERE severity = ? ORDER BY received_at DESC LIMIT ?`,
            )
            .all(severity, clamp(limit)) as Array<Record<string, string>>)
        : (db
            .prepare(
              `SELECT id, source, name, severity, received_at FROM alerts
                ORDER BY received_at DESC LIMIT ?`,
            )
            .all(clamp(limit)) as Array<Record<string, string>>);

      return rows.map((r) => ({
        id: r.id,
        source: r.source,
        name: r.name,
        severity: r.severity,
        receivedAt: r.received_at,
        job: () => jobForAlert(r.id!),
      }));
    },

    alert: ({ id }: { id: string }) => {
      const r = db
        .prepare("SELECT id, source, name, severity, received_at FROM alerts WHERE id = ?")
        .get(id) as Record<string, string> | undefined;
      if (!r) return null;
      return {
        id: r.id,
        source: r.source,
        name: r.name,
        severity: r.severity,
        receivedAt: r.received_at,
        job: () => jobForAlert(id),
      };
    },

    jobs: ({ limit, status }: { limit?: number; status?: string }) => {
      const sql = `SELECT id, kind, status, attempts, max_attempts, last_error, result, payload
                     FROM jobs ${status ? "WHERE status = ?" : ""} ORDER BY id DESC LIMIT ?`;
      const rows = (
        status ? db.prepare(sql).all(status, clamp(limit)) : db.prepare(sql).all(clamp(limit))
      ) as unknown as JobRow[];
      return rows.map(mapJob);
    },

    queueStats: () => {
      const rows = db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").all() as
        Array<{ status: string; n: number }>;
      const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
      return {
        queued: by.queued ?? 0,
        inFlight: by.in_flight ?? 0,
        done: by.done ?? 0,
        dead: by.dead ?? 0,
      };
    },

    auditTrail: ({ limit }: { limit?: number }) => {
      const rows = db
        .prepare(
          `SELECT id, order_id, amount_cents, reason, approved_by, created_at
             FROM refunds ORDER BY id DESC LIMIT ?`,
        )
        .all(clamp(limit)) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: r.id,
        orderId: r.order_id,
        amountCents: r.amount_cents,
        reason: r.reason,
        approvedBy: r.approved_by,
        createdAt: r.created_at,
      }));
    },
  };
}

/** Reject documents nested past MAX_DEPTH before they are executed. */
export function depthOf(query: string): number {
  let depth = 0;
  let max = 0;
  for (const ch of query) {
    if (ch === "{") max = Math.max(max, ++depth);
    else if (ch === "}") depth--;
  }
  return max;
}

export async function execute(
  db: DatabaseSyncInstance,
  source: string,
  variableValues?: Record<string, unknown>,
): Promise<{ data?: unknown; errors?: Array<{ message: string }> }> {
  if (depthOf(source) > MAX_DEPTH) {
    return { errors: [{ message: `Query exceeds maximum depth of ${MAX_DEPTH}.` }] };
  }

  let document;
  try {
    document = parse(source);
  } catch (err) {
    return { errors: [{ message: (err as Error).message }] };
  }

  const validationErrors = validate(schema(), document, specifiedRules);
  if (validationErrors.length > 0) {
    return { errors: validationErrors.map((e) => ({ message: e.message })) };
  }

  const result = await graphql({
    schema: schema(),
    source,
    rootValue: rootValue(db),
    variableValues,
  });

  return {
    data: result.data ?? undefined,
    errors: result.errors?.map((e) => ({ message: e.message })),
  };
}
