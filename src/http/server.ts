/**
 * HTTP surface.
 *
 *   POST /webhooks/alerts      HMAC-signed alert ingestion   -> 202, queued
 *   POST /graphql              read API                      -> OIDC, ops:read
 *   POST /ask                  ask the agent                 -> OIDC, ops:ask
 *   GET  /approvals            pending state changes         -> OIDC, ops:approve
 *   GET  /approvals/:id        one of them                   -> OIDC, ops:approve
 *   POST /approvals/:id        approve or reject             -> OIDC, ops:approve
 *   GET  /healthz              liveness
 *   GET  /, GET /demo/tokens   demo page and demo tokens     -> OPS_COPILOT_DEMO only
 *
 * Alerts come from machines with a shared secret, so they use HMAC. People and
 * services carry OIDC tokens, which give us scopes and a subject for the audit
 * trail. Plain node:http because the routing table is seven lines.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { DatabaseSync, type DatabaseSyncInstance } from "../db/sqlite.js";
import { JobQueue } from "../queue/queue.js";
import { Authenticator, AuthError, SCOPES, requireScope, type Principal } from "./auth.js";
import { receiveAlert, WebhookError } from "./webhooks.js";
import { execute } from "./graphql.js";
import { run } from "../agent/loop.js";
import type { ModelProvider } from "../providers/types.js";
import { pendingApprover, decide, getAction, listActions, ApprovalError, type ActionStatus } from "../approvals/store.js";
import { recordRun } from "../agent/runlog.js";
import { RateLimiter } from "./ratelimit.js";
import { demoPage, type DemoIssuer } from "./demo.js";

export interface ServerOptions {
  dbPath: string;
  provider: ModelProvider;
  auth: Authenticator;
  webhookSecret: string;
  nowIso?: string;
  now?: () => number;
  /** /ask calls per subject: burst size, then refill rate. */
  askBurst?: number;
  askPerMinute?: number;
  log?: (line: Record<string, unknown>) => void;
  /** Demo mode: serves the demo page and mints demo tokens. See demo.ts. */
  demo?: DemoIssuer;
}

const MAX_BODY_BYTES = 256 * 1024;

interface Deps {
  opts: ServerOptions;
  now: () => number;
  limiter: RateLimiter;
  /** Demo token minting per client address. */
  mintLimiter: RateLimiter;
  log: (line: Record<string, unknown>) => void;
}

export function createApp(opts: ServerOptions): Server {
  const now = opts.now ?? Date.now;
  const deps: Deps = {
    opts,
    now,
    limiter: new RateLimiter(opts.askBurst ?? 10, (opts.askPerMinute ?? 30) / 60, now),
    mintLimiter: new RateLimiter(5, 10 / 3600, now),
    log: opts.log ?? ((line) => console.error(JSON.stringify(line))),
  };

  return createServer((req, res) => {
    const requestId = randomUUID();
    res.setHeader("x-request-id", requestId);
    handle(req, res, deps).catch((err) => {
      // Details go to the log, not the client.
      deps.log({ level: "error", requestId, route: `${req.method} ${req.url}`, error: (err as Error).stack });
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error", request_id: requestId });
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: Deps): Promise<void> {
  const { opts, now } = deps;
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = `${req.method} ${url.pathname}`;
  const approvalId = /^\/approvals\/([0-9a-f-]{36})$/.exec(url.pathname)?.[1];

  if (route === "GET /healthz") {
    return sendJson(res, 200, { ok: true });
  }
  if (opts.demo && route === "GET /") {
    const html = demoPage();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html) });
    return void res.end(html);
  }
  if (opts.demo && route === "GET /demo/tokens") {
    // Fresh tokens mean fresh rate-limit buckets on /ask, so minting itself is
    // limited per address. X-Forwarded-For can be forged when nothing in front
    // rewrites it; the daily model budget is the cap that can't be dodged.
    const wait = deps.mintLimiter.take(clientAddress(req));
    if (wait > 0) {
      res.setHeader("retry-after", String(wait));
      return sendJson(res, 429, { error: "rate_limited", message: `Too many demo sessions. Try again in ${wait}s.` });
    }
    return sendJson(res, 200, { ...(await opts.demo.tokens()), model: `${opts.provider.name}/${opts.provider.model}` });
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
        return await handleAsk(res, deps, body, req.headers.authorization);
      case "GET /approvals":
        return await handleListApprovals(res, opts, url, req.headers.authorization);
      default:
        if (approvalId && req.method === "GET") {
          return await handleGetApproval(res, opts, approvalId, req.headers.authorization);
        }
        if (approvalId && req.method === "POST") {
          return await handleDecide(res, deps, approvalId, body, req.headers.authorization);
        }
        return sendJson(res, 404, { error: "not_found", message: `No route for ${route}.` });
    }
  } catch (err) {
    if (err instanceof AuthError) {
      // RFC 6750: tell the client which scheme and why, without leaking detail.
      res.setHeader("WWW-Authenticate", `Bearer error="${err.code}"`);
      return sendJson(res, err.status, { error: err.code, message: err.message });
    }
    if (err instanceof WebhookError || err instanceof ApprovalError) {
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
  deps: Deps,
  body: string,
  authorization: string | undefined,
): Promise<void> {
  const { opts, now } = deps;
  const principal = await opts.auth.authenticate(authorization);
  requireScope(principal, SCOPES.ask);

  const wait = deps.limiter.take(principal.subject);
  if (wait > 0) {
    res.setHeader("retry-after", String(wait));
    return sendJson(res, 429, { error: "rate_limited", message: `Try again in ${wait}s.` });
  }

  let parsed: { question?: unknown };
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    return sendJson(res, 400, { error: "bad_json", message: "Body is not valid JSON." });
  }
  if (typeof parsed.question !== "string" || parsed.question.trim() === "") {
    return sendJson(res, 400, { error: "no_question", message: "Missing 'question'." });
  }
  if (parsed.question.length > 2000) {
    return sendJson(res, 400, { error: "question_too_long", message: "Keep questions under 2000 characters." });
  }

  const startedAt = now();
  const result = await run({
    question: parsed.question,
    dbPath: opts.dbPath,
    provider: opts.provider,
    nowIso: opts.nowIso,
    // Nothing mutates during /ask. State changes are parked for a second person.
    approver: pendingApprover(opts.dbPath, principal.subject, now),
  });
  recordRun(
    opts.dbPath,
    { subject: principal.subject, question: parsed.question, provider: opts.provider, at: startedAt },
    result,
  );

  sendJson(res, result.stoppedBecause === "awaiting_approval" ? 202 : 200, {
    run_id: result.runId,
    answer: result.answer,
    path: result.path,
    tools_used: result.toolsUsed,
    pending_approvals: result.pendingApprovals,
    tokens: result.usage,
    latency_ms: result.latencyMs,
    stopped_because: result.stoppedBecause,
  });
}

const ACTION_STATUSES: ActionStatus[] = ["pending", "executing", "executed", "rejected", "failed", "expired"];

async function handleListApprovals(
  res: ServerResponse,
  opts: ServerOptions,
  url: URL,
  authorization: string | undefined,
): Promise<void> {
  const principal = await opts.auth.authenticate(authorization);
  requireScope(principal, SCOPES.approve);

  const status = (url.searchParams.get("status") ?? "pending") as ActionStatus;
  if (!ACTION_STATUSES.includes(status)) {
    return sendJson(res, 400, { error: "bad_status", message: `status must be one of ${ACTION_STATUSES.join(", ")}.` });
  }

  const db = new DatabaseSync(opts.dbPath, { readOnly: true });
  try {
    const limit = Number(url.searchParams.get("limit") ?? 50) || 50;
    sendJson(res, 200, { approvals: listActions(db, status, limit) });
  } finally {
    db.close();
  }
}

async function handleGetApproval(
  res: ServerResponse,
  opts: ServerOptions,
  id: string,
  authorization: string | undefined,
): Promise<void> {
  const principal = await opts.auth.authenticate(authorization);
  requireScope(principal, SCOPES.approve);

  const db = new DatabaseSync(opts.dbPath, { readOnly: true });
  try {
    const action = getAction(db, id);
    if (!action) return sendJson(res, 404, { error: "not_found", message: "No such approval." });
    sendJson(res, 200, action);
  } finally {
    db.close();
  }
}

async function handleDecide(
  res: ServerResponse,
  deps: Deps,
  id: string,
  body: string,
  authorization: string | undefined,
): Promise<void> {
  const principal = await deps.opts.auth.authenticate(authorization);
  requireScope(principal, SCOPES.approve);

  let parsed: { decision?: unknown; reason?: unknown };
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    return sendJson(res, 400, { error: "bad_json", message: "Body is not valid JSON." });
  }
  if (parsed.decision !== "approve" && parsed.decision !== "reject") {
    return sendJson(res, 400, { error: "bad_decision", message: "decision must be 'approve' or 'reject'." });
  }

  const action = await decide({
    dbPath: deps.opts.dbPath,
    id,
    decision: parsed.decision,
    approver: principal.subject,
    reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 500) : undefined,
    now: deps.now,
  });
  deps.log({ level: "info", event: "approval_decided", id, status: action.status, by: principal.subject });
  sendJson(res, action.status === "failed" ? 422 : 200, action);
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

function clientAddress(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}
