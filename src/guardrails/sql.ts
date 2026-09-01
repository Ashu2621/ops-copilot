/**
 * Read-only enforcement for model-authored SQL.
 *
 * DESIGN NOTE — why there are two layers, and which one is load-bearing.
 *
 * The obvious implementation is a denylist: reject any query containing INSERT,
 * DROP, UPDATE, and so on. That is the wrong primitive to rely on, because it
 * tests the *spelling* of a query rather than its *effect*. It fails in both
 * directions: it rejects the harmless (`SELECT * FROM orders WHERE reason =
 * 'customer requested update'`) and it admits the harmful, because SQL has more
 * ways to write a mutation than a regex has patterns.
 *
 * So the load-bearing control here is the storage engine itself: the query tool
 * holds a connection opened with `readOnly: true`, and SQLite refuses the write
 * at execution time regardless of how the statement was spelled. That check
 * cannot be talked around by the model, because it is not made of text.
 *
 * `assertSingleReadStatement` below is the second layer, and it exists only for
 * ergonomics: it turns a would-be engine error into a fast, specific message the
 * agent can recover from within its loop, and it blocks multi-statement input,
 * which is the one shape where a read prefix could smuggle a second command.
 * If this function were deleted the system would still be safe — just chattier.
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

/** Strip string literals and comments so the shape can be inspected safely. */
function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

/**
 * Reject anything that is not exactly one read statement.
 *
 * Only two properties are checked, both structural rather than lexical:
 *   1. the statement count is one,
 *   2. the statement begins with SELECT or WITH.
 *
 * Everything else — what tables it touches, whether it tries to mutate — is left
 * to the read-only connection, which is authoritative.
 */
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

/** Hard cap on rows returned to the model, to bound both tokens and cost. */
export const MAX_ROWS = 50;

export function truncateRows<T>(rows: T[]): { rows: T[]; truncated: boolean } {
  if (rows.length <= MAX_ROWS) return { rows, truncated: false };
  return { rows: rows.slice(0, MAX_ROWS), truncated: true };
}
