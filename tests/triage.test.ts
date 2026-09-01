import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { classify, triage, MAX_ROUNDS, type AlertInput } from "../src/triage/graph.js";
import { freshDb } from "./fixture.js";

const DB = join(process.cwd(), "data", "test-triage.db");

beforeAll(() => freshDb(DB));
afterAll(() => rmSync(DB, { force: true }));

const alert = (over: Partial<AlertInput> = {}): AlertInput => ({
  name: "PaymentErrorRateHigh",
  severity: "warning",
  summary: "payment error rate 14% over five minutes",
  ...over,
});

describe("classification", () => {
  it("routes payment alerts", () => {
    expect(classify(alert())).toBe("payments");
    expect(classify(alert({ name: "GatewayTimeouts", summary: "declines rising" }))).toBe("payments");
  });

  it("routes latency alerts", () => {
    expect(classify(alert({ name: "CheckoutLatencyHigh", summary: "p95 above 500ms" }))).toBe("latency");
  });

  it("falls back to unknown rather than guessing", () => {
    // A wrong branch gathers the wrong evidence and reaches a confident wrong
    // conclusion. Not knowing is a better default than picking.
    expect(classify(alert({ name: "DiskPressure", summary: "node running hot" }))).toBe("unknown");
  });
});

describe("the graph", () => {
  it("takes the payments branch and reaches a verdict", async () => {
    const result = await triage(alert(), DB);

    expect(result.category).toBe("payments");
    expect(result.path).toContain("gather:payments");
    expect(result.path).toContain("runbook");
    expect(result.verdict).toBeTruthy();
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it("takes the latency branch and pulls throughput alongside latency", async () => {
    const result = await triage(
      alert({ name: "CheckoutLatencyHigh", summary: "p95 latency above 500ms for ten minutes" }),
      DB,
    );

    expect(result.category).toBe("latency");
    expect(result.path).toContain("gather:latency");
    // Latency without throughput is unreadable — the same number means
    // "overloaded" or "stuck" depending on whether traffic moved.
    expect(result.evidence).toHaveLength(2);
  });

  it("records the path it took, so a decision can be explained afterwards", async () => {
    const result = await triage(alert(), DB);
    expect(result.path[0]).toBe("classify");
    expect(result.path).toContain("decide:resolved");
  });

  it("flags a critical alert for a human even when it triaged cleanly", async () => {
    const result = await triage(alert({ severity: "critical" }), DB);
    expect(result.verdict).toBeTruthy();
    expect(result.needsHuman).toBe(true);
  });

  it("does not flag a warning that triaged cleanly", async () => {
    const result = await triage(alert({ severity: "warning" }), DB);
    expect(result.needsHuman).toBe(false);
  });

  it("an unknown alert still gathers broad evidence rather than giving up", async () => {
    const result = await triage(
      alert({ name: "DiskPressure", summary: "node running hot", severity: "warning" }),
      DB,
    );
    expect(result.category).toBe("unknown");
    expect(result.path).toContain("gather:broad");
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it("bounds itself — the loop cannot run forever", async () => {
    const result = await triage(alert(), DB);
    // The cap is enforced by the graph's routing, not by a counter inside a
    // node body that a later edit could forget to increment.
    expect(result.rounds).toBeLessThanOrEqual(MAX_ROUNDS);
  });

  it("never reaches a mutating tool", async () => {
    const result = await triage(alert(), DB);
    // Triage gathers and recommends; it never acts. A graph that could issue a
    // refund would be a second door past the approval gate.
    expect(result.evidence.join(" ")).not.toContain("refund_id");
  });

  it("redacts customer data on this path too", async () => {
    const result = await triage(alert(), DB);
    expect(result.evidence.join(" ")).not.toMatch(/@example\.com/);
  });
});
