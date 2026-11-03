/**
 * Public demo mode (OPS_COPILOT_DEMO=1): a built-in token issuer and a page.
 *
 * The real server only accepts tokens from an OIDC provider, so nobody without
 * an account at that provider can try it. In demo mode the process generates
 * its own RS256 key pair at start-up and hands each visitor two tokens: one for
 * a requester (ops:ask) and one for a different approver (ops:approve), so the
 * two-person refund flow can be walked through end to end. Each visitor gets
 * fresh subjects, so one visitor can't approve another's refund either.
 *
 * Verification is unchanged: the same Authenticator checks signature, issuer,
 * audience, expiry and scopes, it just gets its key set locally instead of from
 * an IdP's JWKS URL. The private key never leaves the process and is gone on
 * restart. Only for the seeded demo database; never enable it on real data.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { SCOPES } from "./auth.js";

export const DEMO_ISSUER = "https://ops-copilot.demo/";
export const DEMO_AUDIENCE = "ops-copilot";
const TOKEN_TTL = "1h";

export interface DemoTokens {
  requester: { subject: string; token: string };
  approver: { subject: string; token: string };
  expires_in: number;
}

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

export class DemoIssuer {
  private constructor(
    private readonly privateKey: PrivateKey,
    readonly keyStore: JWTVerifyGetKey,
  ) {}

  static async create(): Promise<DemoIssuer> {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "demo", alg: "RS256", use: "sig" };
    return new DemoIssuer(privateKey, createLocalJWKSet({ keys: [jwk] }));
  }

  async tokens(): Promise<DemoTokens> {
    const visitor = randomBytes(4).toString("hex");
    const requester = `demo-${visitor}-requester`;
    const approver = `demo-${visitor}-approver`;
    return {
      // The requester can approve too, so the page can show the four-eyes rule
      // refusing a self-approval rather than a plain missing-scope error.
      requester: {
        subject: requester,
        token: await this.sign(requester, [SCOPES.ask, SCOPES.read, SCOPES.approve]),
      },
      approver: { subject: approver, token: await this.sign(approver, [SCOPES.approve, SCOPES.read]) },
      expires_in: 3600,
    };
  }

  private sign(subject: string, scopes: string[]): Promise<string> {
    return new SignJWT({ scope: scopes.join(" ") })
      .setProtectedHeader({ alg: "RS256", kid: "demo" })
      .setIssuer(DEMO_ISSUER)
      .setAudience(DEMO_AUDIENCE)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime(TOKEN_TTL)
      .sign(this.privateKey);
  }
}

let page: string | undefined;

export function demoPage(): string {
  page ??= readFileSync(new URL("./demo.html", import.meta.url), "utf8");
  return page;
}
