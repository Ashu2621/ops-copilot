/**
 * Guardrails for model-written SQL.
 *
 * The real protection is that run_sql only ever gets a read-only connection
 * (see sql-sandbox.ts). SQLite refuses a write however it's spelled, so there
 * is no keyword denylist here to get around.
 *
 * assertSingleReadStatement is a cheap pre-check on top of that. It gives the
 * model a clear error it can recover from, and it rejects multi-statement
 * input. Deleting it would not make the system unsafe, just noisier.
 */

export class SqlGuardError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "SqlGuardError";
  }
}

/** Hard cap on rows returned to the model, to bound tokens and cost. */
export const MAX_ROWS = 50;

/** Wall-clock budget for one model-written query. */
export const QUERY_TIMEOUT_MS = Number(process.env.OPS_COPILOT_SQL_TIMEOUT_MS ?? 2000);

function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

export function assertSingleReadStatement(sql: string): void {
  const bare = stripLiteralsAndComments(sql).trim();

  if (bare.length === 0) {
    throw new SqlGuardError("Query is empty.", "empty_query");
  }

  const withoutTrailing = bare.replace(/;\s*$/, "");
  if (withoutTrailing.includes(";")) {
    throw new SqlGuardError(
      "Only one statement per call. Split this into separate queries.",
      "multiple_statements",
    );
  }

  if (!/^\s*(select|with)\b/i.test(withoutTrailing)) {
    throw new SqlGuardError(
      "Only SELECT (or WITH ... SELECT) queries are allowed on this connection.",
      "not_a_read",
    );
  }
}

/**
 * Wraps the query so SQLite stops after MAX_ROWS + 1 rows. Without this,
 * `SELECT * FROM payments, orders` materialises the whole cross join before
 * we get a chance to truncate it. The newlines keep a trailing `--` comment
 * from swallowing the closing paren.
 */
export function boundedQuery(sql: string): string {
  const body = sql.trim().replace(/;\s*(?:--[^\n]*)?$/, "");
  return `SELECT * FROM (\n${body}\n) LIMIT ${MAX_ROWS + 1}`;
}

export function truncateRows<T>(rows: T[]): { rows: T[]; truncated: boolean } {
  if (rows.length <= MAX_ROWS) return { rows, truncated: false };
  return { rows: rows.slice(0, MAX_ROWS), truncated: true };
}
