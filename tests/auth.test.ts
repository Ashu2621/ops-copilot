import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet, type JWK } from "jose";
import { Authenticator, AuthError, requireScope, parseScopes, SCOPES } from "../src/http/auth.js";

const ISSUER = "https://issuer.test";
const AUDIENCE = "ops-copilot";

// Derived from jose rather than the DOM lib, so the project does not have to
// pull "DOM" into tsconfig just to name a key type in a test.
type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

let signKey: PrivateKey;
let auth: Authenticator;
/** A second issuer, used to prove a token signed by the wrong key is rejected. */
let foreignKey: PrivateKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  signKey = pair.privateKey;
  const jwk = (await exportJWK(pair.publicKey)) as JWK;
  jwk.kid = "test-key";
  jwk.alg = "RS256";

  auth = new Authenticator({
    issuer: ISSUER,
    audience: AUDIENCE,
    keyStore: createLocalJWKSet({ keys: [jwk] }),
  });

  foreignKey = (await generateKeyPair("RS256", { extractable: true })).privateKey;
});

async function token(
  overrides: {
    sub?: string;
    scope?: string;
    iss?: string;
    aud?: string;
    expiresIn?: string;
    key?: PrivateKey;
    notBefore?: string;
  } = {},
): Promise<string> {
  return new SignJWT({ scope: overrides.scope ?? "ops:read ops:ask" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setSubject(overrides.sub ?? "user@corp.example")
    .setIssuer(overrides.iss ?? ISSUER)
    .setAudience(overrides.aud ?? AUDIENCE)
    .setIssuedAt()
    .setNotBefore(overrides.notBefore ?? "0s")
    .setExpirationTime(overrides.expiresIn ?? "5m")
    .sign(overrides.key ?? signKey);
}

describe("bearer header parsing", () => {
  it("extracts a well-formed token", () => {
    expect(Authenticator.bearerFrom("Bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("rejects the shapes that are easy to accept by accident", () => {
    for (const header of [undefined, "", "abc.def.ghi", "Basic abc", "Bearer", "Bearer a b"]) {
      expect(() => Authenticator.bearerFrom(header as string | undefined), String(header)).toThrow(
        AuthError,
      );
    }
  });
});

describe("token verification", () => {
  it("accepts a valid token and exposes subject and scopes", async () => {
    const principal = await auth.authenticate(`Bearer ${await token()}`);
    expect(principal.subject).toBe("user@corp.example");
    expect(principal.scopes.has("ops:read")).toBe(true);
    expect(principal.scopes.has("ops:approve")).toBe(false);
  });

  it("rejects a token signed by a key the issuer never published", async () => {
    await expect(auth.verify(await token({ key: foreignKey }))).rejects.toThrow(AuthError);
  });

  it("rejects a token minted for another issuer", async () => {
    await expect(auth.verify(await token({ iss: "https://evil.test" }))).rejects.toThrow(AuthError);
  });

  it("rejects a token minted for another audience", async () => {
    // The exact confused-deputy case: a real token for a different service.
    await expect(auth.verify(await token({ aud: "some-other-api" }))).rejects.toThrow(AuthError);
  });

  it("rejects an expired token", async () => {
    await expect(auth.verify(await token({ expiresIn: "-1m" }))).rejects.toThrow(AuthError);
  });

  it("rejects a token that is not yet valid", async () => {
    await expect(auth.verify(await token({ notBefore: "10m" }))).rejects.toThrow(AuthError);
  });

  it("rejects an unsigned (alg: none) token", async () => {
    // The algorithm is pinned server-side, so a token claiming 'none' in its
    // header does not get to choose how it is verified.
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({ sub: "attacker", iss: ISSUER, aud: AUDIENCE, exp: 9999999999 }),
    ).toString("base64url");
    await expect(auth.verify(`${header}.${body}.`)).rejects.toThrow(AuthError);
  });

  it("rejects garbage", async () => {
    await expect(auth.verify("not-a-token")).rejects.toThrow(AuthError);
  });
});

describe("scopes", () => {
  it("reads both the space-delimited and array forms", () => {
    expect([...parseScopes({ scope: "a b c" })]).toEqual(["a", "b", "c"]);
    expect([...parseScopes({ scp: ["x", "y"] })]).toEqual(["x", "y"]);
    expect([...parseScopes({})]).toEqual([]);
  });

  it("enforces the required scope with a 403, not a 401", async () => {
    const principal = await auth.authenticate(`Bearer ${await token()}`);
    expect(() => requireScope(principal, SCOPES.read)).not.toThrow();
    try {
      requireScope(principal, SCOPES.approve);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as AuthError).status).toBe(403);
      expect((err as AuthError).code).toBe("insufficient_scope");
    }
  });
});
