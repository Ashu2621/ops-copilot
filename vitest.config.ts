import { defineConfig } from "vitest/config";

/**
 * `node:sqlite` shipped after this Vite version's builtin list was written, so
 * the transform pipeline strips the `node:` prefix, tries to resolve a package
 * called `sqlite` from disk, and fails. This plugin intercepts the specifier
 * first and marks it external, which hands the import straight to Node — which
 * does know about it.
 *
 * Remove once the toolchain recognises `node:sqlite` natively.
 */
const externalNodeSqlite = {
  name: "external-node-sqlite",
  enforce: "pre" as const,
  resolveId(source: string) {
    if (source === "node:sqlite" || source === "sqlite") {
      return { id: "node:sqlite", external: true };
    }
    return null;
  },
};

export default defineConfig({
  plugins: [externalNodeSqlite],
  test: {
    environment: "node",
    // Each suite seeds its own database file; running them in one process
    // keeps those writes off each other's toes.
    fileParallelism: false,
  },
});
