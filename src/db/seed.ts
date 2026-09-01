/**
 * Deterministic seed.
 *
 * Every value is derived from a fixed-seed PRNG and a fixed clock anchor, so the
 * database is byte-identical on every machine. That matters because the eval
 * harness asserts on exact numbers ("how many payments failed in the last hour?")
 * — a random seed would make those assertions flap and the scores meaningless.
 */
import { DatabaseSync } from "./sqlite.js";
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DB_PATH = join(HERE, "..", "..", "data", "ops.db");

/** Fixed instant the dataset is anchored to: 2026-03-14T12:00:00Z. */
export const NOW_MS = Date.UTC(2026, 2, 14, 12, 0, 0);

/** mulberry32 — small, fast, fully deterministic from a 32-bit seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (msAgo: number) => new Date(NOW_MS - msAgo).toISOString();
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

const FIRST = ["Ana", "Bilal", "Chen", "Dara", "Elif", "Farid", "Gita", "Hugo", "Ines", "Jonas"];
const LAST = ["Silva", "Khan", "Wu", "Osei", "Yilmaz", "Haddad", "Rao", "Meyer", "Costa", "Berg"];
const FAILURE_CODES = ["card_declined", "insufficient_funds", "expired_card", "gateway_timeout"];

export function buildDatabase(dbPath: string = DB_PATH): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  rmSync(dbPath, { force: true });

  const db = new DatabaseSync(dbPath);
  db.exec(readFileSync(join(HERE, "schema.sql"), "utf8"));

  const r = rng(20260314);

  const insCustomer = db.prepare(
    "INSERT INTO customers (id, name, email, phone, tier, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (let i = 1; i <= 40; i++) {
    const name = `${pick(r, FIRST)} ${pick(r, LAST)}`;
    const handle = name.toLowerCase().replace(" ", ".");
    insCustomer.run(
      i,
      name,
      `${handle}${i}@example.com`,
      `+1-555-${String(1000 + i).padStart(4, "0")}`,
      pick(r, ["free", "pro", "enterprise"]),
      iso((200 + Math.floor(r() * 160)) * 86_400_000),
    );
  }

  const insOrder = db.prepare(
    "INSERT INTO orders (id, customer_id, status, total_cents, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const insPayment = db.prepare(
    "INSERT INTO payments (id, order_id, status, amount_cents, failure_code, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );

  let paymentId = 1;
  for (let orderId = 1; orderId <= 300; orderId++) {
    const customerId = 1 + Math.floor(r() * 40);
    const totalCents = 1_500 + Math.floor(r() * 48_500);
    // Spread orders across the last 30 days; ~8% land inside the last hour
    // so "recent window" questions have a stable, non-zero answer.
    const recent = r() < 0.08;
    const ageMs = recent
      ? Math.floor(r() * 3_600_000)
      : 3_600_000 + Math.floor(r() * 29 * 86_400_000);

    const paymentFailed = r() < 0.18;
    const status = paymentFailed ? "pending" : pick(r, ["paid", "paid", "shipped", "cancelled"]);
    insOrder.run(orderId, customerId, status, totalCents, iso(ageMs));

    insPayment.run(
      paymentId++,
      orderId,
      paymentFailed ? "failed" : "succeeded",
      totalCents,
      paymentFailed ? pick(r, FAILURE_CODES) : null,
      iso(Math.max(0, ageMs - 60_000)),
    );
  }

  const insRefund = db.prepare(
    "INSERT INTO refunds (id, order_id, amount_cents, reason, approved_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const paidOrders = db
    .prepare("SELECT id, total_cents FROM orders WHERE status IN ('paid','shipped') ORDER BY id")
    .all() as Array<{ id: number; total_cents: number }>;
  let refundId = 1;
  for (const o of paidOrders) {
    if (r() < 0.09) {
      insRefund.run(
        refundId++,
        o.id,
        Math.floor(o.total_cents * (r() < 0.5 ? 1 : 0.5)),
        pick(r, ["damaged_item", "late_delivery", "duplicate_charge", "customer_request"]),
        "ops-console",
        iso(Math.floor(r() * 20 * 86_400_000)),
      );
    }
  }

  const insMetric = db.prepare(
    "INSERT INTO service_metrics (id, name, value, recorded_at) VALUES (?, ?, ?, ?)",
  );
  let metricId = 1;
  // 48 hourly samples per metric, oldest first.
  for (const [metric, base, jitter] of [
    ["checkout_p95_latency_ms", 240, 90],
    ["payment_error_rate", 0.04, 0.03],
    ["orders_per_minute", 12, 5],
  ] as const) {
    for (let h = 47; h >= 0; h--) {
      // A deliberate incident window 5-8 hours ago, so "what happened earlier?"
      // has a real signal to find rather than uniform noise.
      const spike = h >= 5 && h <= 8 ? 2.6 : 1;
      insMetric.run(
        metricId++,
        metric,
        Number((base * spike + (r() - 0.5) * jitter).toFixed(4)),
        iso(h * 3_600_000),
      );
    }
  }

  db.close();
}

// Run directly (`tsx src/db/seed.ts`) but stay silent when imported.
// Compared as URLs because Windows and POSIX disagree on how a path becomes one.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  buildDatabase();
  console.log(`seeded ${DB_PATH}`);
}
