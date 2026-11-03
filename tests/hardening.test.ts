import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, openWritable } from "../src/db/sqlite.js";
import { NOW_MS } from "../src/db/seed.js";
import { Redactor } from "../src/guardrails/pii.js";
import { SqlSandbox } from "../src/guardrails/sql-sandbox.js";
import { MAX_ROWS } from "../src/guardrails/sql.js";
import { TOOLS_BY_NAME, ToolInputError } from "../src/tools/registry.js";
import { openToolContext } from "../src/tools/context.js";
import { pendingApprover, decide, getAction, APPROVAL_TTL_MS } from "../src/approvals/store.js";
import { RateLimiter } from "../src/http/ratelimit.js";
import { run } from "../src/agent/loop.js";
import { approveAll } from "../src/guardrails/approval.js";
import type { ModelProvider, ModelTurn } from "../src/providers/types.js";
import { freshDb } from "./fixture.js";

const DB = join(process.cwd(), "data", "test-hardening.db");
const SLOW_DB = join(process.cwd(), "data", "test-hardening-slow.db");
const NOW = new Date(NOW_MS).toISOString();

beforeEach(() => freshDb(DB));
afterAll(() => {
  rmSync(DB, { force: true });
  try {
    rmSync(SLOW_DB, { force: true });
  } catch {
    // Still held by the abandoned worker on Windows; the next run overwrites it.
  }
});

describe("PII redaction keeps the data the agent needs", () => {
  it("leaves timestamps, decimals and plain amounts alone", () => {
    const r = new Redactor();
    const text = r.json({
      recorded_at: "2026-09-01T10:00:00.000Z",
      created_at: "2026-09-01 10:15:00",
      value: 0.0731,
      amount_cents: 1234567890,
      note: "spike at 2026-09-01T10:05:00Z, 10.0.0.1 timed out",
    });
    expect(text).toContain("2026-09-01T10:00:00.000Z");
    expect(text).toContain("2026-09-01 10:15:00");
    expect(text).toContain("1234567890");
    expect(text).toContain("10.0.0.1");
    expect(r.counts).toEqual({});
  });

  it("still catches phones in free text in common formats", () => {
    const r = new Redactor();
    const text = r.text("call +1-555-1007, (415) 555-0123 or 555-123-4567");
    expect(text).toBe("call [PHONE_1], [PHONE_2] or [PHONE_3]");
  });

  it("tags known PII columns whatever their format", () => {
    const r = new Redactor();
    expect(r.json({ phone: "5551234" })).toBe('{"phone":"[PHONE_1]"}');
  });

  it("gives a value the same tag across separate tool results in one run", () => {
    const r = new Redactor();
    const first = r.json([{ email: "a@x.com" }, { email: "b@x.com" }]);
    const second = r.json({ top: "a@x.com" });
    expect(first).toContain("[EMAIL_1]");
    expect(second).toBe('{"top":"[EMAIL_1]"}');
  });
});

describe("model-written SQL runs off the main thread", () => {
  it("caps rows inside SQLite, not after materialising everything", async () => {
    const sandbox = new SqlSandbox(DB);
    try {
      const rows = await sandbox.query("SELECT * FROM payments p, orders o");
      expect(rows.length).toBe(MAX_ROWS + 1);
    } finally {
      sandbox.close();
    }
  });

  it("handles a trailing comment and semicolon", async () => {
    const sandbox = new SqlSandbox(DB);
    try {
      const rows = await sandbox.query("SELECT COUNT(*) AS n FROM orders; -- how many");
      expect(rows[0]).toEqual({ n: 300 });
    } finally {
      sandbox.close();
    }
  });

  it("times out a slow query and keeps the event loop free", async () => {
    // Own file: the abandoned worker keeps its handle open until SQLite returns,
    // and Windows won't let the next test delete a file that's still open.
    freshDb(SLOW_DB);
    const sandbox = new SqlSandbox(SLOW_DB, 150);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const started = Date.now();
    try {
      await expect(
        sandbox.query(
          "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 10000000) SELECT COUNT(*) FROM c",
        ),
      ).rejects.toMatchObject({ code: "query_timeout" });
      expect(Date.now() - started).toBeLessThan(1500);
      expect(ticks).toBeGreaterThan(3);
    } finally {
      clearInterval(timer);
      sandbox.close();
    }
  });

  it("still refuses writes at the engine", async () => {
    const sandbox = new SqlSandbox(DB);
    try {
      await expect(sandbox.query("WITH x AS (SELECT 1) DELETE FROM orders")).rejects.toMatchObject({
        code: "engine_rejected",
      });
    } finally {
      sandbox.close();
    }
  });
});

describe("issue_refund", () => {
  const refund = TOOLS_BY_NAME.get("issue_refund")!;
  const exec = async (input: Record<string, unknown>, key: string) => {
    const ctx = openToolContext(DB, { writable: true });
    try {
      return (await refund.run(input, ctx, { approvedBy: "bilal", idempotencyKey: key })) as Record<string, unknown>;
    } finally {
      ctx.close();
    }
  };
  const refundedOn = (orderId: number) => {
    const db = new DatabaseSync(DB, { readOnly: true });
    const n = (
      db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM refunds WHERE order_id = ?").get(orderId) as {
        n: number;
      }
    ).n;
    db.close();
    return n;
  };

  it("caps the running total, not just each refund", async () => {
    // Order 2 is paid, total 128.28.
    await exec({ order_id: 2, amount_cents: 10000, reason: "a" }, "k1");
    await expect(exec({ order_id: 2, amount_cents: 10000, reason: "b" }, "k2")).rejects.toThrow(/exceeds/);
    await exec({ order_id: 2, amount_cents: 2828, reason: "c" }, "k3");
    expect(refundedOn(2)).toBe(12828);
    await expect(exec({ order_id: 2, amount_cents: 1, reason: "d" }, "k4")).rejects.toThrow(/exceeds/);
  });

  it("returns the first result for a repeated idempotency key", async () => {
    const first = await exec({ order_id: 1, amount_cents: 500, reason: "x" }, "same");
    const second = await exec({ order_id: 1, amount_cents: 500, reason: "x" }, "same");
    expect(second.refund_id).toBe(first.refund_id);
    expect(second.replayed).toBe(true);
    expect(refundedOn(1)).toBe(500);
  });

  it("refuses unpaid and cancelled orders", async () => {
    await expect(exec({ order_id: 7, amount_cents: 100, reason: "x" }, "c1")).rejects.toBeInstanceOf(ToolInputError);
  });

  it("won't run without an approval", async () => {
    const ctx = openToolContext(DB, { writable: true });
    try {
      expect(() => refund.run({ order_id: 1, amount_cents: 1, reason: "x" }, ctx)).toThrow(/without an approval/);
    } finally {
      ctx.close();
    }
  });
});

describe("approval store", () => {
  const park = () =>
    pendingApprover(DB, "ana", () => NOW_MS)({
      runId: "run-1",
      tool: "issue_refund",
      input: { order_id: 1, amount_cents: 700, reason: "late" },
      summary: "Refund $7.00 on order #1",
    });

  it("expires stale approvals", async () => {
    const d = await park();
    if (d.status !== "pending") throw new Error("expected pending");
    await expect(
      decide({ dbPath: DB, id: d.approvalId, decision: "approve", approver: "bilal", now: () => NOW_MS + APPROVAL_TTL_MS + 1 }),
    ).rejects.toMatchObject({ status: 410 });
  });

  it("finishes a crashed execution without paying twice", async () => {
    const d = await park();
    if (d.status !== "pending") throw new Error("expected pending");
    await decide({ dbPath: DB, id: d.approvalId, decision: "approve", approver: "bilal", now: () => NOW_MS });

    // Simulate dying after the refund committed but before `executed` was written.
    const db = openWritable(DB);
    db.prepare("UPDATE pending_actions SET status = 'executing' WHERE id = ?").run(d.approvalId);
    db.close();

    const again = await decide({ dbPath: DB, id: d.approvalId, decision: "approve", approver: "carol", now: () => NOW_MS });
    expect(again.status).toBe("executed");
    expect((again.result as { replayed?: boolean }).replayed).toBe(true);

    const check = new DatabaseSync(DB, { readOnly: true });
    const n = (check.prepare("SELECT COUNT(*) AS n FROM refunds WHERE idempotency_key = ?").get(`approval:${d.approvalId}`) as { n: number }).n;
    expect(getAction(check, d.approvalId)?.status).toBe("executed");
    check.close();
    expect(n).toBe(1);
  });

  it("marks business-rule failures as final", async () => {
    const d = await pendingApprover(DB, "ana", () => NOW_MS)({
      runId: "run-2",
      tool: "issue_refund",
      input: { order_id: 1, amount_cents: 99_999_999, reason: "too much" },
      summary: "big",
    });
    if (d.status !== "pending") throw new Error("expected pending");
    const out = await decide({ dbPath: DB, id: d.approvalId, decision: "approve", approver: "bilal", now: () => NOW_MS });
    expect(out.status).toBe("failed");
    expect(out.error).toMatch(/exceeds/);
  });
});

describe("agent loop edges", () => {
  /** A provider that records what it was sent and plays back fixed turns. */
  class Scripted implements ModelProvider {
    readonly name = "scripted";
    readonly model = "test";
    readonly seen: unknown[][] = [];
    constructor(
      private readonly turns: Array<Partial<ModelTurn> | Error>,
      private readonly price = 0,
    ) {}
    priceUsd() {
      return this.price;
    }
    async send({ history }: { history: unknown[] }): Promise<ModelTurn> {
      this.seen.push(structuredClone(history));
      const t = this.turns[this.seen.length - 1] ?? { text: "done" };
      if (t instanceof Error) throw t;
      return { raw: [], text: "", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 10 }, ...t };
    }
  }
  const refundCall = (id: string, order: number) => ({
    stopReason: "tool_use" as const,
    toolCalls: [{ id, name: "issue_refund", input: { order_id: order, amount_cents: 100, reason: "x" } }],
  });

  it("redacts the question before the model sees it", async () => {
    const p = new Scripted([{ text: "ok" }]);
    await run({ question: "why did ana.silva7@example.com get charged twice?", dbPath: DB, provider: p, nowIso: NOW, useRouter: false });
    expect(JSON.stringify(p.seen[0])).not.toContain("ana.silva7@example.com");
    expect(JSON.stringify(p.seen[0])).toContain("[EMAIL_1]");
  });

  it("asks the approver separately for each mutating call", async () => {
    const asked: string[] = [];
    let n = 0;
    const p = new Scripted([refundCall("a", 1), refundCall("b", 2), { text: "done" }]);
    const r = await run({
      question: "refund two orders",
      dbPath: DB,
      provider: p,
      nowIso: NOW,
      useRouter: false,
      // Approve the first, deny the second. The old loop kept the first
      // approval on the shared context and let the second one through.
      approver: async (req) => {
        asked.push(req.summary);
        return n++ === 0
          ? { status: "approved", decidedBy: "bilal" }
          : { status: "denied", decidedBy: "bilal", reason: "no" };
      },
    });
    expect(asked).toHaveLength(2);
    expect(r.steps.map((s) => s.ok)).toEqual([true, false]);
  });

  it("stops when the cost budget is spent", async () => {
    const p = new Scripted(
      [
        { stopReason: "tool_use", toolCalls: [{ id: "1", name: "run_sql", input: { sql: "SELECT 1 AS one" } }] },
        { stopReason: "tool_use", toolCalls: [{ id: "2", name: "run_sql", input: { sql: "SELECT 2 AS two" } }] },
      ],
      0.2,
    );
    const r = await run({ question: "q", dbPath: DB, provider: p, nowIso: NOW, useRouter: false, maxCostUsd: 0.3 });
    expect(r.stoppedBecause).toBe("budget");
    expect(p.seen).toHaveLength(2);
  });

  it("turns a provider failure into a result instead of throwing", async () => {
    const r = await run({
      question: "q",
      dbPath: DB,
      provider: new Scripted([new Error("upstream 529")]),
      nowIso: NOW,
      useRouter: false,
    });
    expect(r.stoppedBecause).toBe("model_error");
    expect(r.answer).toContain("upstream 529");
  });

  it("rejects a nonsense step limit instead of silently doing nothing", async () => {
    await expect(
      run({ question: "q", dbPath: DB, provider: new Scripted([]), maxSteps: Number("abc"), useRouter: false }),
    ).rejects.toThrow(RangeError);
  });

  it("refunds once when the model repeats the same call", async () => {
    const p = new Scripted([refundCall("a", 1), refundCall("b", 1), { text: "done" }]);
    const r = await run({ question: "q", dbPath: DB, provider: p, nowIso: NOW, useRouter: false, approver: approveAll });
    expect(r.steps.map((s) => s.detail ?? "ok")).toEqual(["ok", "duplicate_call"]);
  });
});

describe("rate limiter", () => {
  it("refills over time and evicts idle keys past the cap", () => {
    let t = 0;
    const rl = new RateLimiter(2, 1, () => t, 2);
    expect(rl.take("a")).toBe(0);
    expect(rl.take("a")).toBe(0);
    expect(rl.take("a")).toBeGreaterThan(0);
    t += 1000;
    expect(rl.take("a")).toBe(0);

    rl.take("b");
    rl.take("c"); // evicts "a", the idlest
    expect(rl.take("a")).toBe(0); // fresh bucket
  });
});
