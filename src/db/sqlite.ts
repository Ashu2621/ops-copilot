/**
 * Single entry point for Node's built-in SQLite.
 *
 * Why the indirection: `node:sqlite` is newer than the builtin list baked into
 * the Vite version Vitest runs on, so a direct `import ... from "node:sqlite"`
 * gets picked up by the transform pipeline, which strips the `node:` prefix and
 * then fails to find a package called `sqlite` on disk. Loading it through
 * `createRequire` keeps the specifier out of the static import graph, so it
 * reaches Node untouched.
 *
 * The type import on the last line is erased at compile time, so it costs
 * nothing at runtime while keeping full type safety at the call sites.
 *
 * Delete this file and import `node:sqlite` directly once the toolchain
 * recognises it.
 */
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);
const sqlite = nodeRequire("node:sqlite") as typeof import("node:sqlite");

export const { DatabaseSync } = sqlite;
export type { DatabaseSync as DatabaseSyncInstance } from "node:sqlite";
