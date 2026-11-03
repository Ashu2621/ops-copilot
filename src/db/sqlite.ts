// node:sqlite is loaded through createRequire because the Vite version under
// Vitest doesn't know it as a builtin yet and strips the `node:` prefix.
// Import it directly once the toolchain catches up.
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncInstance } from "node:sqlite";

const nodeRequire = createRequire(import.meta.url);
const sqlite = nodeRequire("node:sqlite") as typeof import("node:sqlite");

export const { DatabaseSync } = sqlite;
export type { DatabaseSyncInstance };

/** Opens a read-write handle that waits on a locked file instead of failing. */
export function openWritable(path: string): DatabaseSyncInstance {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/**
 * Runs `fn` inside BEGIN IMMEDIATE. IMMEDIATE takes the write lock up front,
 * so a read-check-write sequence can't interleave with another writer.
 */
export function immediate<T>(db: DatabaseSyncInstance, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
