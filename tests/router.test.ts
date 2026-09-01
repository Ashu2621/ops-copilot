import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DatabaseSync, type DatabaseSyncInstance } from "../src/db/sqlite.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { route } from "../src/agent/router.js";
import { searchRunbooks } from "../src/rag/retrieve.js";
import { buildDatabase, NOW_MS } from "../src/db/seed.js";

const DB = join(process.cwd(), "data", "test-router.db");
const NOW = new Date(NOW_MS).toISOString();
let db: DatabaseSyncInstance;

beforeAll(() => {
  buildDatabase(DB);
  db = new DatabaseSync(DB, { readOnly: true });
});
afterAll(() => {
  db.close();
  rmSync(DB, { force: true });
});

describe("deterministic router", () => {
  it("answers failed-payments-in-the-last-hour without a model", () => {
    const r = route("How many payments failed in the last hour?", db, NOW);
    expect(r.kind).toBe("direct");
    if (r.kind !== "direct") return;
    expect(r.intent).toBe("failed_payments_last_hour");
    // The seed is fixed, so this number is a contract, not a sample.
    expect(r.answer).toBe("9 payment(s) failed in the last hour.");
  });

  it("answers pending orders", () => {
    const r = route("how many orders are pending?", db, NOW);
    expect(r.kind).toBe("direct");
    if (r.kind !== "direct") return;
    expect(r.answer).toBe("51 order(s) are currently pending.");
  });

  it("answers current p95 latency", () => {
    const r = route("what is the current p95 latency?", db, NOW);
    expect(r.kind).toBe("direct");
    if (r.kind !== "direct") return;
    expect(r.intent).toBe("current_p95_latency");
  });

  it("distinguishes the last-hour window from the all-time count", () => {
    const hour = route("failed payments in the last hour", db, NOW);
    const all = route("how many payments failed in total?", db, NOW);
    expect(hour.kind).toBe("direct");
    expect(all.kind).toBe("direct");
    if (hour.kind !== "direct" || all.kind !== "direct") return;
    expect(hour.intent).not.toBe(all.intent);
    expect(all.answer).toContain("51");
  });

  it("escalates anything it does not recognise", () => {
    const r = route("why did the checkout flow regress after yesterday's deploy?", db, NOW);
    expect(r.kind).toBe("escalate");
  });

  it("escalates rather than half-matching a similar question", () => {
    // Mentions payments but asks something no intent covers.
    const r = route("which payment provider should we migrate to?", db, NOW);
    expect(r.kind).toBe("escalate");
  });
});

describe("runbook retrieval", () => {
  it("finds the gateway-timeout procedure", () => {
    const hits = searchRunbooks("gateway_timeout spike on payments", 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.source).toBe("payments.md");
    expect(hits[0]!.heading.toLowerCase()).toContain("gateway_timeout");
  });

  it("routes latency questions to the latency runbook", () => {
    const hits = searchRunbooks("checkout p95 latency above 500ms", 2);
    expect(hits[0]!.source).toBe("latency.md");
  });

  it("surfaces the refund rules for refund questions", () => {
    const hits = searchRunbooks("when is a refund appropriate duplicate charge", 3);
    expect(hits.some((h) => h.source === "refunds.md")).toBe(true);
  });

  it("returns nothing for a query of pure stopwords", () => {
    expect(searchRunbooks("the and of it", 3)).toHaveLength(0);
  });

  it("ranks deterministically", () => {
    const a = searchRunbooks("gateway timeout", 3);
    const b = searchRunbooks("gateway timeout", 3);
    expect(a.map((h) => h.heading)).toEqual(b.map((h) => h.heading));
  });
});
