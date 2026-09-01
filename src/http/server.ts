/**
 * HTTP surface.
 *
 *   POST /webhooks/alerts   HMAC-signed alert ingestion  -> 202, work queued
 *   POST /graphql           read API                     -> OIDC, ops:read
 *   POST /ask               ask the agent                -> OIDC, ops:ask
 *   GET  /healthz           liveness
 *
 * Two authentication schemes on purpose, because there are two kinds of caller.
 * A monitoring system posting an alert is a machine with a shared secret and no
 * user identity, which is what HMAC is for. A person or service querying the API
 * carries an OIDC token, which is what scopes and an audit subject are for.
 * Using one mechanism for both would mean either handing alerting systems an
 * OAuth client or accepting a shared secret as proof of human identity.
 *
 * Built on node:http rather than a framework — the routing table is four
 * entries, and keeping the dependency list short is what lets a reviewer run
 * this from a clean checkout.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { DatabaseSync, type DatabaseSyncInstance } from "../db/sqlite.js";
import { JobQueue } from "../queue/queue.js";
import { Authenticator, AuthError, SCOPES, requireScope, type Principal } from "./auth.js";
import { receiveAlert, WebhookError } from "./webhooks.js";
import { execute } from "./graphql.js";
import { run } from "../agent/loop.js";
import type { ModelProvider } from "../providers/types.js";
import type { Approver } from "../guardrails/approval.js";

export interface ServerOptions {
  dbPath: string;
  provider: ModelProvider;
  auth: Authenticator;
  webhookSecret: string;
  nowIso?: string;
  now?: () => number;
}

const MAX_BODY_BYTES = 256 * 1024;

export function createApp(opts: ServerOptions): Server {
  const now = opts.now ?? Date.now;

  return createServer((req, res) => {
    handle(req, res, opts, now).catch((err) => {
      sendJson(res, 500, { error: "internal_error", message: (err as Error).message });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ServerOptions,
  now: () => number,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /healthz") {
    return sendJson(res, 200, { ok: true });
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    return sendJson(res, 413, { error: "payload_too_large", message: (err as Error).message });
  }

  try {
    switch (route) {
      case "POST /webhooks/alerts":
        return handleWebhook(res, opts, body, headersOf(req), now());
      case "POST /graphql":
        return await handleGraphql(res, opts, body, req.headers.authorization);
      case "POST /ask":
        return await handleAsk(res, opts, body, req.headers.authorization);
      default:
        return sendJson(res, 404, { error: "not_found", message: `No route for ${route}.` });
    }
  } catch (err) {
    if (err instanceof AuthError) {
      // RFC 6750: tell the client which scheme and why, without leaking detail.
      res.setHeader("WWW-Authenticate", `Bearer error="${err.code}"`);
      return sendJson(res, err.status, { error: err.code, message: err.message });
    }
    if (err instanceof WebhookError) {
      return sendJson(res, err.status, { error: err.code, message: err.message });
    }
    throw err;
  }
}

function handleWebhook(
  res: ServerResponse,
  opts: ServerOptions,
  body: string,
  headers: Record<string, string | undefined>,
  now: number,
): void {
  const db = new DatabaseSync(opts.dbPath);
  const queue = new JobQueue(db, () => now);
  try {
    const result = receiveAlert({ db, queue, secret: opts.webhookSecret, headers, body, now });
    sendJson(res, result.status, {
      delivery_id: result.deliveryId,
      job_id: result.jobId ?? null,
      duplicate: result.duplicate,
    });
  } finally {
    db.close();
  }
}

async function handleGraphql(
  res: ServerResponse,
  opts: ServerOptions,
  body: string,
  authorization: string | undefined,
): Promise<void> {
  const principal = await opts.auth.authenticate(authorization);
  requireScope(principal, SCOPES.read);

  let parsed: { query?: string; variables?: Record<string, unknown> };
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    return sendJson(res, 400, { error: "bad_json", message: "Body is not valid JSON." });
  }
  if (!parsed.query) {
    return sendJson(res, 400, { error: "no_query", message: "Missing 'query'." });
  }

  const db = new DatabaseSync(opts.dbPath, { readOnly: true });
  try {
    const result = await execute(db, parsed.query, parsed.variables);
    sendJson(res, result.errors ? 400 : 200, result);
  } finally {
    db.close();
  }
}

async function handleAsk(
  res: ServerResponse,
  opts: ServerOptions,
  body: string,
  authorization: string | undefined,
): Promise<void> {
  const principal = await opts.auth.authenticate(authorization);
  requireScope(principal, SCOPES.ask);

  let parsed: { question?: string; allow_state_change?: boolean };
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    return sendJson(res, 400, { error: "bad_json", message: "Body is not valid JSON." });
  }
  if (!parsed.question) {
    return sendJson(res, 400, { error: "no_question", message: "Missing 'question'." });
  }

  const result = await run({
    question: parsed.question,
    dbPath: opts.dbPath,
    provider: opts.provider,
    nowIso: opts.nowIso,
    approver: approverFor(principal, parsed.allow_state_change === true),
  });

  sendJson(res, 200, {
    answer: result.answer,
    path: result.path,
    tools_used: result.toolsUsed,
    tokens: result.usage,
    latency_ms: result.latencyMs,
    stopped_because: result.stoppedBecause,
  });
}

/**
 * Turn a verified token into an approver.
 *
 * This is the join between OIDC and the human-in-the-loop gate: approval is
 * granted only when the caller both holds `ops:approve` AND asked for it
 * explicitly on this request, and the identity written to `refunds.approved_by`
 * is the token subject — not a hardcoded label. That is what makes the audit
 * trail answer "who authorised this refund?" months later.
 */
export function approverFor(principal: Principal, requested: boolean): Approver {
  return async () => {
    if (!requested) {
      return {
        approved: false,
        decidedBy: "not-requested",
        reason: "Caller did not set allow_state_change.",
      };
    }
    if (!principal.scopes.has(SCOPES.approve)) {
      return {
        approved: false,
        decidedBy: principal.subject,
        reason: `Subject lacks the '${SCOPES.approve}' scope.`,
      };
    }
    return { approved: true, decidedBy: principal.subject };
  };
}

function headersOf(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`Body exceeds ${MAX_BODY_BYTES} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

export type { DatabaseSyncInstance };
