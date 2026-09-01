/**
 * End-to-end over real HTTP: a live server on an ephemeral port, real signed
 * webhooks, real OIDC bearer tokens, real fetch calls.
 *
 * The unit tests cover each guard in isolation; this file is the one that would
 * catch them being wired up wrongly — a route that forgets to check a scope, a
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

beforeAll(async () => {
  freshDb(DB);

  const pair = await generateKeyPair("RS256", { extractable: true });
  signKey = pair.privateKey;
  const jwk = (await exportJWK(pair.publicKey)) as JWK;
  jwk.kid = "k1";
  jwk.alg = "RS256";

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
  // socket to drain — which, with idle keep-alive sockets, means waiting for
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

describe("state change requires identity, scope, and intent", () => {
  const refundQuestion = "Please issue a refund for order 12.";

  const countRefunds = () => {
    const db = new DatabaseSync(DB, { readOnly: true });
    const n = (db.prepare("SELECT COUNT(*) AS n FROM refunds").get() as { n: number }).n;
    db.close();
    return n;
  };

  it("refuses when the caller has ops:approve but did not ask", async () => {
    const before = countRefunds();
    await fetch(`${base}/ask`, {
      method: "POST",
      headers: { authorization: `Bearer ${await token("ops:ask ops:approve")}` },
      body: JSON.stringify({ question: refundQuestion }),
    });
    expect(countRefunds()).toBe(before);
  });

  it("refuses when the caller asked but lacks ops:approve", async () => {
    const before = countRefunds();
    await fetch(`${base}/ask`, {
      method: "POST",
      headers: { authorization: `Bearer ${await token("ops:ask")}` },
      body: JSON.stringify({ question: refundQuestion, allow_state_change: true }),
    });
    expect(countRefunds()).toBe(before);
  });

  it("performs it — and records the token subject as the approver", async () => {
    const before = countRefunds();
    const res = await fetch(`${base}/ask`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await token("ops:ask ops:approve", "bilal@corp.example")}`,
      },
      body: JSON.stringify({ question: refundQuestion, allow_state_change: true }),
    });
    expect(res.status).toBe(200);
    expect(countRefunds()).toBe(before + 1);

    const db = new DatabaseSync(DB, { readOnly: true });
    const row = db
      .prepare("SELECT approved_by FROM refunds ORDER BY id DESC LIMIT 1")
      .get() as { approved_by: string };
    db.close();
    // The whole point of adding OIDC: the audit trail names a person.
    expect(row.approved_by).toBe("bilal@corp.example");
  });
});

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
