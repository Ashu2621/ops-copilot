/**
 * Demo mode: the built-in issuer must produce tokens the normal Authenticator
 * accepts, and nothing else about the server may loosen. The four-eyes rule,
 * scopes and signature checks all run exactly as they do against a real IdP.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { generateKeyPair, SignJWT } from "jose";
import { createApp } from "../src/http/server.js";
import { Authenticator } from "../src/http/auth.js";
import { MockProvider } from "../src/providers/mock.js";
import { DEMO_AUDIENCE, DEMO_ISSUER, DemoIssuer, type DemoTokens } from "../src/http/demo.js";
import { NOW_MS } from "../src/db/seed.js";
import { freshDb } from "./fixture.js";

const DB = join(process.cwd(), "data", "test-demo.db");
let server: Server;
let base: string;

beforeAll(async () => {
  freshDb(DB);
  const demo = await DemoIssuer.create();
  server = createApp({
    dbPath: DB,
    provider: new MockProvider(),
    auth: new Authenticator({ issuer: DEMO_ISSUER, audience: DEMO_AUDIENCE, keyStore: demo.keyStore }),
    webhookSecret: "unused",
    nowIso: new Date(NOW_MS).toISOString(),
    now: () => NOW_MS,
    demo,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(DB, { force: true });
});

const tokens = async () => (await (await fetch(`${base}/demo/tokens`)).json()) as DemoTokens;
const post = (path: string, token: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

describe("demo mode", () => {
  it("serves the demo page", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("/demo/tokens");
  });

  it("walks the two-person refund flow with the issued tokens", async () => {
    const t = await tokens();
    expect(t.requester.subject).not.toBe(t.approver.subject);

    const asked = await post("/ask", t.requester.token, { question: "Please issue a refund for order 12." });
    expect(asked.status).toBe(202);
    const { pending_approvals } = (await asked.json()) as { pending_approvals: Array<{ id: string }> };
    expect(pending_approvals).toHaveLength(1);
    const id = pending_approvals[0]!.id;

    const self = await post(`/approvals/${id}`, t.requester.token, { decision: "approve" });
    expect(self.status).toBe(403);
    expect(((await self.json()) as { error: string }).error).toBe("self_approval");

    const approved = await post(`/approvals/${id}`, t.approver.token, { decision: "approve" });
    expect(approved.status).toBe(200);
    const action = (await approved.json()) as { status: string; decidedBy: string };
    expect(action.status).toBe("executed");
    expect(action.decidedBy).toBe(t.approver.subject);
  });

  it("gives every visitor their own subjects, so visitors can't approve each other's refunds", async () => {
    const a = await tokens();
    const b = await tokens();
    expect(new Set([a.requester.subject, a.approver.subject, b.requester.subject, b.approver.subject]).size).toBe(4);
  });

  it("names the model and limits how fast one address can mint tokens", async () => {
    const mint = () => fetch(`${base}/demo/tokens`, { headers: { "x-forwarded-for": "203.0.113.9" } });
    const first = await mint();
    expect(((await first.json()) as { model: string }).model).toBe("mock/mock-scripted");
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await mint()).status);
    expect(statuses.slice(0, 4)).toEqual([200, 200, 200, 200]);
    expect(statuses[4]).toBe(429);
    // A different address has its own allowance.
    expect((await fetch(`${base}/demo/tokens`, { headers: { "x-forwarded-for": "198.51.100.4" } })).status).toBe(200);
  });

  it("still rejects tokens it did not sign", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const forged = await new SignJWT({ scope: "ops:ask" })
      .setProtectedHeader({ alg: "RS256", kid: "demo" })
      .setIssuer(DEMO_ISSUER)
      .setAudience(DEMO_AUDIENCE)
      .setSubject("mallory")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const res = await post("/ask", forged, { question: "How many payments failed in the last hour?" });
    expect(res.status).toBe(401);
  });
});

describe("without demo mode", () => {
  it("has no demo routes", async () => {
    const plain = createApp({
      dbPath: DB,
      provider: new MockProvider(),
      auth: new Authenticator({ issuer: "https://issuer.test", audience: "a", keyStore: async () => { throw new Error("no"); } }),
      webhookSecret: "s",
    });
    await new Promise<void>((resolve) => plain.listen(0, resolve));
    const url = `http://127.0.0.1:${(plain.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${url}/demo/tokens`)).status).toBe(404);
      expect((await fetch(`${url}/`)).status).toBe(404);
    } finally {
      plain.closeAllConnections();
      await new Promise<void>((resolve) => plain.close(() => resolve()));
    }
  });
});
