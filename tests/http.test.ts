/**
 * End-to-end over real HTTP: a live server on an ephemeral port, real signed
 * webhooks, real OIDC bearer tokens, real fetch calls.
 *
 * The unit tests cover each guard in isolation; this file is the one that would
 * catch them being wired up wrongly: a route that forgets to check a scope, a
 * webhook handler mounted behind auth, an error mapped to the wrong status.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet, type JWK } from "jose";
import { createApp } from "../src/http/server.js";
import { Authenticator } from "../src/http/auth.js";
import { JobQueue } from "../src/queue/queue.js";
import { drain } from "../src/queue/worker.js";
import { MockProvider } from "../src/providers/mock.js";
import { sign, SIGNATURE_HEADER, TIMESTAMP_HEADER, DELIVERY_HEADER } from "../src/http/webhooks.js";
import { DatabaseSync } from "../src/db/sqlite.js";
import { NOW_MS } from "../src/db/seed.js";
import { freshDb } from "./fixture.js";

const DB = join(process.cwd(), "data", "test-http.db");
const SECRET = "whsec_integration";
const ISSUER = "https://issuer.test";
const AUDIENCE = "ops-copilot";

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

let server: Server;
let base: string;
let signKey: PrivateKey;
let publicJwk: JWK;

beforeAll(async () => {
  freshDb(DB);

  const pair = await generateKeyPair("RS256", { extractable: true });
  signKey = pair.privateKey;
  const jwk = (await exportJWK(pair.publicKey)) as JWK;
  jwk.kid = "k1";
  jwk.alg = "RS256";
  publicJwk = jwk;

  server = createApp({
    dbPath: DB,
    provider: new MockProvider(),
    auth: new Authenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      keyStore: createLocalJWKSet({ keys: [jwk] }),
    }),
    webhookSecret: SECRET,
    nowIso: new Date(NOW_MS).toISOString(),
    now: () => NOW_MS,
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  // `fetch` keeps connections alive, and `server.close()` waits for every open
  // socket to drain, which, with idle keep-alive sockets, means waiting for
  // their timeout. Dropping them explicitly is what makes teardown immediate
  // instead of adding minutes to the suite.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(DB, { force: true });
});

const token = (scope: string, sub = "ana@corp.example") =>
  new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signKey);

function postAlert(deliveryId: string, alert: Record<string, unknown>) {
  const body = JSON.stringify(alert);
  const ts = String(NOW_MS);
  return fetch(`${base}/webhooks/alerts`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [TIMESTAMP_HEADER]: ts,
      [SIGNATURE_HEADER]: sign(SECRET, ts, body),
      [DELIVERY_HEADER]: deliveryId,
    },
    body,
  });
}

describe("HTTP surface", () => {
  it("serves liveness without credentials", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("404s an unknown route", async () => {
    const res = await fetch(`${base}/nope`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });
});

describe("webhook route", () => {
  it("accepts a signed alert and queues work", async () => {
    const res = await postAlert("http-1", {
      name: "PaymentErrorRateHigh",
      severity: "critical",
      summary: "error rate 14%",
      source: "alertmanager",
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { job_id: number; duplicate: boolean };
    expect(body.duplicate).toBe(false);
    expect(body.job_id).toBeGreaterThan(0);
  });

  it("acknowledges a redelivery without queueing twice", async () => {
    const res = await postAlert("http-1", {
      name: "PaymentErrorRateHigh",
      severity: "critical",
      summary: "error rate 14%",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { duplicate: boolean }).duplicate).toBe(true);
  });

  it("rejects an unsigned alert with 401", async () => {
    const res = await fetch(`${base}/webhooks/alerts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X", severity: "info", summary: "y" }),
    });
    expect(res.status).toBe(401);
  });

  it("does NOT accept an OIDC token in place of a signature", async () => {
    // The two schemes are not interchangeable: a valid user token must not be
    // enough to inject an alert.
    const body = JSON.stringify({ name: "X", severity: "info", summary: "y" });
    const res = await fetch(`${base}/webhooks/alerts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await token("ops:read ops:ask ops:approve")}`,
        [DELIVERY_HEADER]: "http-oidc",
      },
      body,
    });
    expect(res.status).toBe(401);
  });
});

describe("authenticated routes", () => {
  it("rejects a missing token with 401 and a WWW-Authenticate header", async () => {
    const res = await fetch(`${base}/graphql`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("rejects a valid token that lacks the scope with 403", async () => {
    const res = await fetch(`${base}/graphql`, {
      method: "POST",
      headers: { authorization: `Bearer ${await token("ops:ask")}` },
      body: JSON.stringify({ query: "{ queueStats { queued } }" }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("insufficient_scope");
  });

  it("serves GraphQL to a token with ops:read", async () => {
    const res = await fetch(`${base}/graphql`, {
      method: "POST",
      headers: { authorization: `Bearer ${await token("ops:read")}` },
      body: JSON.stringify({ query: "{ alerts { id name } queueStats { queued } }" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { alerts: Array<{ id: string }> } };
    expect(body.data.alerts.map((a) => a.id)).toContain("http-1");
  });

  it("answers a question on /ask", async () => {
    const res = await fetch(`${base}/ask`, {
      method: "POST",
      headers: { authorization: `Bearer ${await token("ops:ask")}` },
      body: JSON.stringify({ question: "How many payments failed in the last hour?" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { answer: string; path: string };
    expect(body.path).toBe("router");
    expect(body.answer).toContain("9 payment(s)");
  });
});

describe("state changes go through a second person", () => {
  const refundQuestion = "Please issue a refund for order 12.";

  const countRefunds = () => {
    const db = new DatabaseSync(DB, { readOnly: true });
    const n = (db.prepare("SELECT COUNT(*) AS n FROM refunds").get() as { n: number }).n;
    db.close();
    return n;
  };

  const ask = async (sub: string) => {
    const res = await fetch(`${base}/ask`, {
      method: "POST",
      headers: { authorization: `Bearer ${await token("ops:ask ops:approve", sub)}` },
      body: JSON.stringify({ question: refundQuestion }),
    });
    return { status: res.status, body: (await res.json()) as AskBody };
  };

  const decide = async (id: string, sub: string, decision: "approve" | "reject", scope = "ops:approve") =>
    fetch(`${base}/approvals/${id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${await token(scope, sub)}` },
      body: JSON.stringify({ decision }),
    });

  it("parks the refund during /ask, even for a caller holding ops:approve", async () => {
    const before = countRefunds();
    const { status, body } = await ask("ana@corp.example");

    expect(status).toBe(202);
    expect(body.stopped_because).toBe("awaiting_approval");
    expect(body.pending_approvals).toHaveLength(1);
    expect(body.pending_approvals[0]!.summary).toContain("order #12");
    expect(countRefunds()).toBe(before);
  });

  it("won't let the requester approve their own refund", async () => {
    const { body } = await ask("ana@corp.example");
    const res = await decide(body.pending_approvals[0]!.id, "ana@corp.example", "approve");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("self_approval");
  });

  it("needs ops:approve to decide", async () => {
    const { body } = await ask("ana@corp.example");
    const res = await decide(body.pending_approvals[0]!.id, "bilal@corp.example", "approve", "ops:ask");
    expect(res.status).toBe(403);
  });

  it("runs the exact stored action once a second person approves, and only once", async () => {
    const before = countRefunds();
    const { body } = await ask("ana@corp.example");
    const id = body.pending_approvals[0]!.id;

    const first = await decide(id, "bilal@corp.example", "approve");
    expect(first.status).toBe(200);
    const action = (await first.json()) as { status: string; result: { approved_by: string; amount_cents: number } };
    expect(action.status).toBe("executed");
    expect(action.result.approved_by).toBe("bilal@corp.example");
    expect(action.result.amount_cents).toBe(2500);
    expect(countRefunds()).toBe(before + 1);

    const again = await decide(id, "carol@corp.example", "approve");
    expect(again.status).toBe(409);
    expect(countRefunds()).toBe(before + 1);
  });

  it("rejecting records who said no and runs nothing", async () => {
    const before = countRefunds();
    const { body } = await ask("ana@corp.example");
    const res = await decide(body.pending_approvals[0]!.id, "bilal@corp.example", "reject");
    expect(((await res.json()) as { status: string; decidedBy: string }).decidedBy).toBe("bilal@corp.example");
    expect(countRefunds()).toBe(before);
  });

  it("lists pending approvals for approvers only", async () => {
    await ask("ana@corp.example");
    const denied = await fetch(`${base}/approvals`, {
      headers: { authorization: `Bearer ${await token("ops:ask")}` },
    });
    expect(denied.status).toBe(403);

    const res = await fetch(`${base}/approvals?status=pending`, {
      headers: { authorization: `Bearer ${await token("ops:approve", "bilal@corp.example")}` },
    });
    const list = (await res.json()) as { approvals: Array<{ status: string; tool: string }> };
    expect(list.approvals.length).toBeGreaterThan(0);
    expect(list.approvals.every((a) => a.status === "pending" && a.tool === "issue_refund")).toBe(true);
  });

  it("logs every /ask with its subject and cost", async () => {
    const db = new DatabaseSync(DB, { readOnly: true });
    const row = db
      .prepare("SELECT subject, stopped_because FROM agent_runs WHERE subject = ? ORDER BY created_at DESC LIMIT 1")
      .get("ana@corp.example") as { subject: string; stopped_because: string } | undefined;
    db.close();
    expect(row?.stopped_because).toBe("awaiting_approval");
  });
});

describe("hardening", () => {
  it("rate limits /ask per subject", async () => {
    const limited = createApp({
      dbPath: DB,
      provider: new MockProvider(),
      auth: new Authenticator({
        issuer: ISSUER,
        audience: AUDIENCE,
        keyStore: createLocalJWKSet({ keys: [publicJwk] }),
      }),
      webhookSecret: SECRET,
      nowIso: new Date(NOW_MS).toISOString(),
      now: () => NOW_MS,
      askBurst: 2,
      askPerMinute: 1,
    });
    await new Promise<void>((resolve) => limited.listen(0, resolve));
    const url = `http://127.0.0.1:${(limited.address() as AddressInfo).port}/ask`;
    const auth = `Bearer ${await token("ops:ask", "rate@corp.example")}`;
    const hit = () =>
      fetch(url, {
        method: "POST",
        headers: { authorization: auth },
        body: JSON.stringify({ question: "How many orders are pending right now?" }),
      });

    try {
      expect((await hit()).status).toBe(200);
      expect((await hit()).status).toBe(200);
      const third = await hit();
      expect(third.status).toBe(429);
      expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
    } finally {
      limited.closeAllConnections();
      await new Promise<void>((resolve) => limited.close(() => resolve()));
    }
  });

  it("returns a request id on 500s instead of the error message", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const broken = createApp({
      dbPath: join(process.cwd(), "data", "does-not-exist", "nope.db"),
      provider: new MockProvider(),
      auth: new Authenticator({
        issuer: ISSUER,
        audience: AUDIENCE,
        keyStore: createLocalJWKSet({ keys: [publicJwk] }),
      }),
      webhookSecret: SECRET,
      log: (l) => lines.push(l),
    });
    await new Promise<void>((resolve) => broken.listen(0, resolve));
    const url = `http://127.0.0.1:${(broken.address() as AddressInfo).port}/graphql`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${await token("ops:read")}` },
        body: JSON.stringify({ query: "{ queueStats { queued } }" }),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ error: "internal_error", request_id: res.headers.get("x-request-id") });
      expect(lines[0]?.level).toBe("error");
    } finally {
      broken.closeAllConnections();
      await new Promise<void>((resolve) => broken.close(() => resolve()));
    }
  });
});

interface AskBody {
  stopped_because: string;
  pending_approvals: Array<{ id: string; summary: string }>;
}

describe("webhook -> queue -> agent, end to end", () => {
  it("triages the alert that arrived over HTTP", async () => {
    const queue = JobQueue.open(DB, () => NOW_MS);
    const processed = await drain({
      queue,
      dbPath: DB,
      provider: new MockProvider(),
      nowIso: new Date(NOW_MS).toISOString(),
    });
    expect(processed).toBeGreaterThan(0);

    const res = await fetch(`${base}/graphql`, {
      method: "POST",
      headers: { authorization: `Bearer ${await token("ops:read")}` },
      body: JSON.stringify({ query: `{ alert(id: "http-1") { job { status answer } } }` }),
    });
    const body = (await res.json()) as {
      data: { alert: { job: { status: string; answer: string } } };
    };

    expect(body.data.alert.job.status).toBe("done");
    expect(body.data.alert.job.answer).toBeTruthy();
    queue.close();
  });
});
