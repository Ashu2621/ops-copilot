/**
 * OAuth 2.0 / OIDC bearer-token authentication and scope-based authorization.
 *
 * DESIGN NOTE — why this is not decoration.
 *
 * The agent has a tool that moves money. The approval gate already refuses to
 * run it without a human saying yes — but "a human said yes" is only worth
 * something if you can say *which* human, later, when someone asks why a refund
 * was issued. Before this file existed the audit trail recorded the string
 * "cli-operator", which is a label, not an identity.
 *
 * So the token subject is what gets written to `refunds.approved_by`. OIDC here
 * is the thing that makes the human-in-the-loop guarantee auditable rather than
 * merely present.
 *
 * Verification is delegated to `jose` against the issuer's published JWKS.
 * Three properties are enforced and none of them are optional:
 *   - signature, against a key fetched from the issuer (never from the token),
 *   - `iss` and `aud`, so a token minted for another service is rejected here,
 *   - `exp` / `nbf`, with a small clock tolerance.
 *
 * The algorithm is pinned. Accepting whatever `alg` the token header claims is
 * how `alg: none` and RS256-verified-as-HS256 confusion get in — the header is
 * attacker-controlled input, so it does not get a vote.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

export interface AuthConfig {
  issuer: string;
  audience: string;
  /** Overridable so tests can verify against a locally generated key set. */
  keyStore?: JWTVerifyGetKey;
  jwksUri?: string;
  clockToleranceSec?: number;
}

export interface Principal {
  subject: string;
  scopes: Set<string>;
  claims: JWTPayload;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
    readonly code: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export const SCOPES = {
  read: "ops:read",
  ask: "ops:ask",
  approve: "ops:approve",
} as const;

export class Authenticator {
  private readonly keyStore: JWTVerifyGetKey;

  constructor(private readonly config: AuthConfig) {
    if (config.keyStore) {
      this.keyStore = config.keyStore;
    } else {
      const uri = config.jwksUri ?? new URL("/.well-known/jwks.json", config.issuer).toString();
      this.keyStore = createRemoteJWKSet(new URL(uri));
    }
  }

  /** Extract a bearer token, rejecting the malformed header shapes early. */
  static bearerFrom(header: string | undefined): string {
    if (!header) throw new AuthError("Missing Authorization header.", 401, "no_credentials");
    const match = /^Bearer[ ]+(\S+)$/.exec(header.trim());
    if (!match) throw new AuthError("Expected 'Bearer <token>'.", 401, "malformed_header");
    return match[1]!;
  }

  async verify(token: string): Promise<Principal> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.keyStore, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        // Pinned, not read from the token header.
        algorithms: ["RS256"],
        clockTolerance: this.config.clockToleranceSec ?? 5,
      }));
    } catch (err) {
      throw new AuthError(`Token rejected: ${(err as Error).message}`, 401, "invalid_token");
    }

    if (!payload.sub) {
      throw new AuthError("Token has no subject.", 401, "no_subject");
    }

    return { subject: payload.sub, scopes: parseScopes(payload), claims: payload };
  }

  async authenticate(authorizationHeader: string | undefined): Promise<Principal> {
    return this.verify(Authenticator.bearerFrom(authorizationHeader));
  }
}

/**
 * Scopes may arrive as the space-delimited `scope` string (RFC 8693) or as a
 * `scp` array, depending on the provider. Both are read; neither is assumed.
 */
export function parseScopes(payload: JWTPayload): Set<string> {
  const out = new Set<string>();
  const scope = payload.scope;
  if (typeof scope === "string") for (const s of scope.split(/\s+/)) if (s) out.add(s);
  const scp = payload.scp;
  if (Array.isArray(scp)) for (const s of scp) if (typeof s === "string") out.add(s);
  return out;
}

export function requireScope(principal: Principal, scope: string): void {
  if (!principal.scopes.has(scope)) {
    throw new AuthError(
      `This action requires the '${scope}' scope.`,
      403,
      "insufficient_scope",
    );
  }
}
