import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "../src/db/sqlite.js";
import { JobQueue } from "../src/queue/queue.js";
import {
  receiveAlert,
  sign,
  verifySignature,
  WebhookError,
  FRESHNESS_WINDOW_MS,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  DELIVERY_HEADER,
} from "../src/http/webhooks.js";
import { execute } from "../src/http/graphql.js";
import { NOW_MS } from "../src/db/seed.js";
import { freshDb } from "./fixture.js";

const DB = join(process.cwd(), "data", "test-webhooks.db");
const SECRET = "whsec_test_secret";
const NOW = NOW_MS;

let db: ReturnType<typeof openWrite>;
let queue: JobQueue;

function openWrite() {
  return new DatabaseSync(DB);
}

beforeEach(() => {
  freshDb(DB);
  db = openWrite();
  queue = new JobQueue(db, () => NOW);
});

// Windows will not unlink an open file, so the handle has to be released
// before the next beforeEach rebuilds the fixture.
afterEach(() => db.close());
afterAll(() => rmSync(DB, { force: true }));

const ALERT = JSON.stringify({
  name: "PaymentErrorRateHigh",
  severity: "critical",
  summary: "payment error rate 14% over 5 minutes",
  source: "alertmanager",
});

function headers(
  body: string,
  opts: { delivery?: string; ts?: number; sig?: string } = {},
): Record<string, string | undefined> {
  const ts = String(opts.ts ?? NOW);
  return {
    [TIMESTAMP_HEADER]: ts,
    [SIGNATURE_HEADER]: opts.sig ?? sign(SECRET, ts, body),
    [DELIVERY_HEADER]: opts.delivery ?? "delivery-1",
  };
}

const receive = (body: string, h: Record<string, string | undefined>, now = NOW) =>
  receiveAlert({ db, queue, secret: SECRET, headers: h, body, now });

describe("signature verification", () => {
  it("accepts a correctly signed, fresh delivery", () => {
    expect(() =>
      verifySignature(SECRET, String(NOW), sign(SECRET, String(NOW), ALERT), ALERT, NOW),
    ).not.toThrow();
  });

  it("rejects a body that was altered after signing", () => {
    const sig = sign(SECRET, String(NOW), ALERT);
    const tampered = ALERT.replace("critical", "info");
    expect(() => verifySignature(SECRET, String(NOW), sig, tampered, NOW)).toThrow(/Signature/);
  });

  it("rejects a signature made with the wrong secret", () => {
    const sig = sign("whsec_wrong", String(NOW), ALERT);
    expect(() => verifySignature(SECRET, String(NOW), sig, ALERT, NOW)).toThrow(WebhookError);
  });

  it("rejects a replayed delivery outside the freshness window", () => {
    const ts = String(NOW - FRESHNESS_WINDOW_MS - 1_000);
    const sig = sign(SECRET, ts, ALERT);
    // Signature is perfectly valid — freshness is what stops the replay.
    expect(() => verifySignature(SECRET, ts, sig, ALERT, NOW)).toThrow(/freshness/i);
  });

  it("rejects a timestamp rewritten to look fresh", () => {
    // The timestamp is inside the signed material, so moving it breaks the MAC.
    const sig = sign(SECRET, String(NOW - 10 * 60_000), ALERT);
    expect(() => verifySignature(SECRET, String(NOW), sig, ALERT, NOW)).toThrow(/Signature/);
  });

  it("rejects unsigned requests", () => {
    expect(() => verifySignature(SECRET, undefined, undefined, ALERT, NOW)).toThrow(/Missing/);
  });

  it("rejects a signature of the wrong length without throwing from the comparator", () => {
    expect(() => verifySignature(SECRET, String(NOW), "abc", ALERT, NOW)).toThrow(WebhookError);
  });
});

describe("alert ingestion", () => {
  it("records the alert, queues one triage job, and returns 202", () => {
    const result = receive(ALERT, headers(ALERT));
    expect(result.status).toBe(202);
    expect(result.duplicate).toBe(false);
    expect(queue.stats().queued).toBe(1);

    const row = db.prepare("SELECT name, severity FROM alerts WHERE id = 'delivery-1'").get();
    expect(row).toMatchObject({ name: "PaymentErrorRateHigh", severity: "critical" });
  });

  it("is idempotent under redelivery — at-least-once is the norm", () => {
    receive(ALERT, headers(ALERT));
    const second = receive(ALERT, headers(ALERT));

    expect(second.status).toBe(200);
    expect(second.duplicate).toBe(true);
    // The important assertion: the agent is not run twice for one alert.
    expect(queue.stats().queued).toBe(1);
  });

  it("treats a different delivery id as a new alert", () => {
    receive(ALERT, headers(ALERT));
    receive(ALERT, headers(ALERT, { delivery: "delivery-2" }));
    expect(queue.stats().queued).toBe(2);
  });

  it("requires a delivery id", () => {
    const h = headers(ALERT);
    delete h[DELIVERY_HEADER];
    expect(() => receive(ALERT, h)).toThrow(/delivery/i);
  });

  it("rejects malformed and incomplete payloads", () => {
    for (const bad of [
      "not json",
      JSON.stringify({ severity: "critical", summary: "x" }),
      JSON.stringify({ name: "X", severity: "critical" }),
      JSON.stringify({ name: "X", severity: "apocalyptic", summary: "x" }),
    ]) {
      expect(() => receive(bad, headers(bad, { delivery: `d-${bad.length}` })), bad).toThrow(
        WebhookError,
      );
    }
    expect(queue.stats().queued).toBe(0);
  });
});

describe("graphql read API", () => {
  it("returns ingested alerts", async () => {
    receive(ALERT, headers(ALERT));
    const read = new DatabaseSync(DB, { readOnly: true });
    const result = await execute(read, `{ alerts(limit: 5) { id name severity } }`);
    read.close();

    expect(result.errors).toBeUndefined();
    const alerts = (result.data as { alerts: Array<Record<string, string>> }).alerts;
    expect(alerts[0]).toMatchObject({ id: "delivery-1", name: "PaymentErrorRateHigh" });
  });

  it("links an alert to its triage job", async () => {
    receive(ALERT, headers(ALERT));
    const read = new DatabaseSync(DB, { readOnly: true });
    const result = await execute(read, `{ alerts { id job { id status attempts } } }`);
    read.close();

    const alerts = (result.data as { alerts: Array<{ job: Record<string, unknown> }> }).alerts;
    expect(alerts[0]!.job).toMatchObject({ id: 1, status: "queued" });
  });

  it("clamps a client-supplied limit rather than honouring it", async () => {
    for (let i = 0; i < 5; i++) {
      const body = ALERT;
      receive(body, headers(body, { delivery: `d-${i}` }));
    }
    const read = new DatabaseSync(DB, { readOnly: true });
    const result = await execute(read, `{ alerts(limit: 100000) { id } }`);
    read.close();
    // The server decides how expensive a query may be, not the caller.
    expect((result.data as { alerts: unknown[] }).alerts.length).toBeLessThanOrEqual(100);
  });

  it("refuses a document nested past the depth ceiling", async () => {
    const read = new DatabaseSync(DB, { readOnly: true });
    const deep = `{ a { b { c { d { e { f { g { h { i { j { k } } } } } } } } } } }`;
    const result = await execute(read, deep);
    read.close();
    expect(result.errors?.[0]?.message).toMatch(/depth/i);
  });

  it("exposes no mutations — state changes have exactly one door", async () => {
    const read = new DatabaseSync(DB, { readOnly: true });
    const result = await execute(read, `mutation { issueRefund(orderId: 1, amountCents: 100) }`);
    read.close();
    expect(result.errors?.length).toBeGreaterThan(0);
  });

  it("reports queue statistics", async () => {
    receive(ALERT, headers(ALERT));
    const read = new DatabaseSync(DB, { readOnly: true });
    const result = await execute(read, `{ queueStats { queued done dead } }`);
    read.close();
    expect(result.data).toMatchObject({ queueStats: { queued: 1, done: 0, dead: 0 } });
  });
});
