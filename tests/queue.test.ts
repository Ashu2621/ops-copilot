import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "../src/db/sqlite.js";
import { JobQueue, backoffMs } from "../src/queue/queue.js";
import { drain, alertToQuestion } from "../src/queue/worker.js";
import { MockProvider } from "../src/providers/mock.js";
import { NOW_MS } from "../src/db/seed.js";
import { freshDb } from "./fixture.js";

const DB = join(process.cwd(), "data", "test-queue.db");
let clock = NOW_MS;
const now = () => clock;

beforeEach(() => {
  freshDb(DB);
  clock = NOW_MS;
});
afterAll(() => rmSync(DB, { force: true }));

const openQueue = () => JobQueue.open(DB, now);

describe("job queue", () => {
  it("enqueues and claims in order", () => {
    const q = openQueue();
    q.enqueue("triage_alert", { alertId: "a" });
    q.enqueue("triage_alert", { alertId: "b" });

    expect(q.claim()).toMatchObject({ kind: "triage_alert", payload: { alertId: "a" } });
    expect(q.claim()).toMatchObject({ payload: { alertId: "b" } });
    expect(q.claim()).toBeNull();
    q.close();
  });

  it("hides a claimed job from other workers until its lease expires", () => {
    const q = openQueue();
    q.enqueue("triage_alert", { alertId: "a" });

    const first = q.claim(30_000);
    expect(first).not.toBeNull();

    // A second worker polling now must not get the same job.
    expect(q.claim(30_000)).toBeNull();

    // ...but once the lease lapses, the job must come back. This is the
    // difference between a queue and a to-do list: a crashed worker loses
    // nothing.
    clock += 31_000;
    const reclaimed = q.claim(30_000);
    expect(reclaimed?.id).toBe(first!.id);
    q.close();
  });

  it("does not resurrect a completed job when the lease would have expired", () => {
    const q = openQueue();
    q.enqueue("triage_alert", { alertId: "a" });
    const job = q.claim(30_000)!;
    q.complete(job.id, { answer: "done" });

    clock += 60_000;
    expect(q.claim()).toBeNull();
    expect(q.stats().done).toBe(1);
    q.close();
  });

  it("retries with backoff, then dead-letters at max attempts", () => {
    const q = openQueue();
    q.enqueue("triage_alert", { alertId: "a" }, { maxAttempts: 3 });

    // attempt 1
    expect(q.fail(q.claim()!.id, "boom")).toBe("retrying");
    // The retry is not immediately claimable — that is the backoff working.
    expect(q.claim()).toBeNull();

    clock += backoffMs(1);
    expect(q.fail(q.claim()!.id, "boom")).toBe("retrying");

    clock += backoffMs(2);
    expect(q.fail(q.claim()!.id, "boom")).toBe("dead");

    // A poison message must stop consuming workers, not loop forever.
    clock += 10 * 60_000;
    expect(q.claim()).toBeNull();
    expect(q.stats().dead).toBe(1);
    q.close();
  });

  it("grows the backoff and caps it", () => {
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(2)).toBe(4_000);
    expect(backoffMs(3)).toBe(9_000);
    expect(backoffMs(1_000)).toBe(60_000);
  });

  it("hands a job to exactly one of two racing workers", () => {
    const q1 = openQueue();
    const q2 = openQueue();
    q1.enqueue("triage_alert", { alertId: "a" });

    const claims = [q1.claim(), q2.claim()].filter(Boolean);
    expect(claims).toHaveLength(1);

    q1.close();
    q2.close();
  });
});

describe("alert worker", () => {
  it("triages a queued alert with the agent and records the result", async () => {
    const q = openQueue();
    q.enqueue("triage_alert", {
      alertId: "d-1",
      name: "CheckoutLatencyHigh",
      severity: "critical",
      summary: "p95 latency above 500ms for 10 minutes",
    });

    const processed = await drain({
      queue: q,
      dbPath: DB,
      provider: new MockProvider(),
      nowIso: new Date(NOW_MS).toISOString(),
    });

    expect(processed).toBe(1);
    expect(q.stats().done).toBe(1);

    const db = new DatabaseSync(DB, { readOnly: true });
    const row = db.prepare("SELECT result FROM jobs WHERE id = 1").get() as { result: string };
    db.close();

    const result = JSON.parse(row.result);
    expect(result.answer).toBeTruthy();
    expect(result.toolsUsed).toContain("get_metric_series");
    q.close();
  });

  it("dead-letters an unknown job kind instead of retrying it forever", async () => {
    const q = openQueue();
    q.enqueue("send_smoke_signal", {}, { maxAttempts: 1 });

    await drain({ queue: q, dbPath: DB, provider: new MockProvider() });

    expect(q.stats().dead).toBe(1);
    q.close();
  });

  it("phrases the alert as the question an engineer would ask", () => {
    const q = alertToQuestion({
      alertId: "x",
      name: "PaymentErrorRateHigh",
      severity: "warning",
      summary: "error rate 12%",
    });
    expect(q).toContain("PaymentErrorRateHigh");
    expect(q).toContain("warning");
    expect(q).toContain("what should I do");
  });
});
