/**
 * Inbound alert webhook.
 *
 * An alerting system (Alertmanager, PagerDuty, a monitoring vendor) POSTs here
 * when something fires; the alert is recorded, a triage job is enqueued, and the
 * handler returns 202 immediately. It does not run the agent inline — senders
 * retry on a slow response, so triaging in the request path would turn one alert
 * into several.
 *
 * Three properties an inbound webhook has to get right, all tested:
 *
 * 1. AUTHENTICITY. The endpoint is public, so anything unsigned is attacker
 *    input. Signature is HMAC-SHA256 over `timestamp.body` — the timestamp is
 *    inside the signed material, otherwise it can be rewritten freely, which
 *    would defeat (2).
 *
 * 2. FRESHNESS. A valid signature is valid forever, so a captured request could
 *    be replayed indefinitely. Deliveries outside a tolerance window are
 *    refused.
 *
 * 3. IDEMPOTENCY. At-least-once delivery is the norm, not the exception: a
 *    sender that times out waiting for us will resend. `alerts.id` is the
 *    delivery id and a PRIMARY KEY, so a duplicate collides at the database
 *    instead of enqueueing a second triage run.
 *
 * Comparison is `timingSafeEqual`. A plain `===` on a signature leaks its
 * content through response timing, one byte at a time.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { DatabaseSyncInstance } from "../db/sqlite.js";
import type { JobQueue } from "../queue/queue.js";

export const SIGNATURE_HEADER = "x-ops-signature";
export const TIMESTAMP_HEADER = "x-ops-timestamp";
export const DELIVERY_HEADER = "x-ops-delivery";

/** How far a delivery's timestamp may drift before it is refused. */
export const FRESHNESS_WINDOW_MS = 5 * 60 * 1000;

export class WebhookError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 409,
    readonly code: string,
  ) {
    super(message);
    this.name = "WebhookError";
  }
}

export function sign(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function verifySignature(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  body: string,
  now: number,
): void {
  if (!timestamp || !signature) {
    throw new WebhookError("Missing signature headers.", 401, "unsigned");
  }

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) {
    throw new WebhookError("Timestamp is not a number.", 400, "bad_timestamp");
  }
  if (Math.abs(now - sentAt) > FRESHNESS_WINDOW_MS) {
    throw new WebhookError("Delivery is outside the freshness window.", 401, "stale_delivery");
  }

  const expected = Buffer.from(sign(secret, timestamp, body), "utf8");
  const actual = Buffer.from(signature, "utf8");

  // Length must match before timingSafeEqual, which throws on a mismatch —
  // and the length check itself must not short-circuit the comparison below.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new WebhookError("Signature does not match.", 401, "bad_signature");
  }
}

export interface AlertPayload {
  name: string;
  severity: "info" | "warning" | "critical";
  summary: string;
  source?: string;
}

export function parseAlert(body: string): AlertPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new WebhookError("Body is not valid JSON.", 400, "bad_json");
  }

  const alert = raw as Partial<AlertPayload>;
  if (!alert.name || typeof alert.name !== "string") {
    throw new WebhookError("Alert is missing 'name'.", 400, "missing_name");
  }
  if (!alert.summary || typeof alert.summary !== "string") {
    throw new WebhookError("Alert is missing 'summary'.", 400, "missing_summary");
  }
  if (alert.severity !== "info" && alert.severity !== "warning" && alert.severity !== "critical") {
    throw new WebhookError("severity must be info, warning or critical.", 400, "bad_severity");
  }

  return {
    name: alert.name,
    severity: alert.severity,
    summary: alert.summary,
    source: typeof alert.source === "string" ? alert.source : "unknown",
  };
}

export interface ReceiveResult {
  status: 202 | 200;
  deliveryId: string;
  jobId?: number;
  duplicate: boolean;
}

export function receiveAlert(args: {
  db: DatabaseSyncInstance;
  queue: JobQueue;
  secret: string;
  headers: Record<string, string | undefined>;
  body: string;
  now: number;
}): ReceiveResult {
  const { db, queue, secret, headers, body, now } = args;

  verifySignature(secret, headers[TIMESTAMP_HEADER], headers[SIGNATURE_HEADER], body, now);

  const deliveryId = headers[DELIVERY_HEADER];
  if (!deliveryId) {
    throw new WebhookError(`Missing ${DELIVERY_HEADER}.`, 400, "no_delivery_id");
  }

  const alert = parseAlert(body);

  const seen = db.prepare("SELECT id FROM alerts WHERE id = ?").get(deliveryId);
  if (seen) {
    // Redelivery. Acknowledge without queueing a second triage run — the
    // sender needs a 2xx or it will keep retrying.
    return { status: 200, deliveryId, duplicate: true };
  }

  db.prepare(
    `INSERT INTO alerts (id, source, name, severity, payload, received_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    deliveryId,
    alert.source ?? "unknown",
    alert.name,
    alert.severity,
    body,
    new Date(now).toISOString(),
  );

  const jobId = queue.enqueue("triage_alert", {
    alertId: deliveryId,
    name: alert.name,
    severity: alert.severity,
    summary: alert.summary,
  });

  return { status: 202, deliveryId, jobId, duplicate: false };
}
