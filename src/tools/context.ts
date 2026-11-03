import { DatabaseSync, openWritable, type DatabaseSyncInstance } from "../db/sqlite.js";
import { SqlSandbox } from "../guardrails/sql-sandbox.js";
import type { ToolContext } from "./registry.js";

export interface OpenToolContext extends ToolContext {
  close(): void;
}

/**
 * Everything a tool call needs, opened lazily and closed in one place.
 * `writable: false` is for surfaces that must never mutate (MCP, triage).
 */
export function openToolContext(dbPath: string, opts: { writable: boolean }): OpenToolContext {
  const readDb = new DatabaseSync(dbPath, { readOnly: true });
  let sandbox: SqlSandbox | null = null;
  let writeDb: DatabaseSyncInstance | null = null;

  return {
    readDb,
    sql: (query) => (sandbox ??= new SqlSandbox(dbPath)).query(query),
    writeDb: () => {
      if (!opts.writable) throw new Error("This surface has no write access.");
      return (writeDb ??= openWritable(dbPath));
    },
    close: () => {
      sandbox?.close();
      writeDb?.close();
      readDb.close();
    },
  };
}
