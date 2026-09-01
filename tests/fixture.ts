/**
 * Fast per-test fixture databases.
 *
 * Seeding writes 300 orders, 300 payments and 144 metric samples, which takes
 * roughly three seconds. Doing that in a `beforeEach` across ~60 tests put the
 * suite at three minutes — slow enough that people stop running it locally,
 * which is the point at which a test suite starts decaying.
 *
 * So the fixture is built once into a template and each test gets a byte copy
 * of it: same isolation, a file copy instead of a rebuild. The template is
 * regenerated whenever the schema or the seed is newer than it, so a change to
 * either cannot leave tests running against a stale shape.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDatabase } from "../src/db/seed.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DB = join(HERE, "..", "src", "db");
const TEMPLATE = join(process.cwd(), "data", ".fixture-template.db");

function templateIsStale(): boolean {
  if (!existsSync(TEMPLATE)) return true;
  const built = statSync(TEMPLATE).mtimeMs;
  return ["schema.sql", "seed.ts"].some((f) => {
    const p = join(SRC_DB, f);
    return existsSync(p) && statSync(p).mtimeMs > built;
  });
}

/** Give this test its own database, seeded and isolated. */
export function freshDb(path: string): void {
  if (templateIsStale()) buildDatabase(TEMPLATE);
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  copyFileSync(TEMPLATE, path);
}
