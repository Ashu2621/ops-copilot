import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "../src/db/sqlite.js";
import { run } from "../src/agent/loop.js";
import { MockProvider } from "../src/providers/mock.js";
import { approveAll, denyAll } from "../src/guardrails/approval.js";
import { buildDatabase, NOW_MS } from "../src/db/seed.js";

const DB = join(process.cwd(), "data", "test-agent.db");
const NOW = new Date(NOW_MS).toISOString();

const ask = (question: string, approve = false) =>
  run({
    question,
    dbPath: DB,
    provider: new MockProvider(),
    nowIso: NOW,
    approver: approve ? approveAll : denyAll,
  });

beforeAll(() => buildDatabase(DB));
afterAll(() => rmSync(DB, { force: true }));

describe("agent loop", () => {
  it("uses the router and spends nothing on a known intent", async () => {
    const r = await ask("How many payments failed in the last hour?");
    expect(r.path).toBe("router");
    expect(r.usage.inputTokens).toBe(0);
    expect(r.usage.costUsd).toBe(0);
    expect(r.toolsUsed).toHaveLength(0);
  });

  it("escalates to the model and dispatches a tool", async () => {
    const r = await ask("Give me the failure code breakdown.");
    expect(r.path).toBe("model");
    expect(r.toolsUsed).toContain("run_sql");
    expect(r.stoppedBecause).toBe("answered");
    expect(r.usage.inputTokens).toBeGreaterThan(0);
  });

  it("blocks a destructive query and reports it back to the model as an error", async () => {
    const r = await ask("Delete all cancelled orders.");
    const failed = r.steps.find((s) => !s.ok);
    expect(failed?.tool).toBe("run_sql");
    expect(failed?.detail).toContain("not_a_read");

    // And the data is untouched.
    const db = new DatabaseSync(DB, { readOnly: true });
    const n = (db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status='cancelled'").get() as { n: number }).n;
    db.close();
    expect(n).toBeGreaterThan(0);
  });

  it("refuses a state change when no human approves", async () => {
    const before = countRefunds();
    const r = await ask("Please issue a refund for order 12.", false);

    const step = r.steps.find((s) => s.tool === "issue_refund");
    expect(step?.ok).toBe(false);
    expect(step?.approved).toBe(false);
    expect(countRefunds()).toBe(before);
  });

  it("performs the state change once a human approves", async () => {
    const before = countRefunds();
    const r = await ask("Please issue a refund for order 12.", true);

    const step = r.steps.find((s) => s.tool === "issue_refund");
    expect(step?.ok).toBe(true);
    expect(step?.approved).toBe(true);
    expect(countRefunds()).toBe(before + 1);
  });

  it("redacts customer contact details before they reach the model", async () => {
    const r = await ask("Which customers placed the most orders?");
    expect(r.redactions.EMAIL ?? 0).toBeGreaterThan(0);
    expect(r.answer).not.toMatch(/@example\.com/);
  });

  it("stops at the step limit instead of looping forever", async () => {
    const r = await run({
      question: "Checkout felt slow earlier, what does the latency series show?",
      dbPath: DB,
      provider: new MockProvider(),
      nowIso: NOW,
      maxSteps: 1, // the scenario needs two tool calls, so it cannot finish
    });
    expect(r.stoppedBecause).toBe("step_limit");
    expect(r.steps.length).toBeLessThanOrEqual(1);
  });
});

function countRefunds(): number {
  const db = new DatabaseSync(DB, { readOnly: true });
  const n = (db.prepare("SELECT COUNT(*) AS n FROM refunds").get() as { n: number }).n;
  db.close();
  return n;
}
