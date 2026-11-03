/**
 * OIDC bearer tokens and scopes.
 *
 * The token subject is who gets recorded as the approver of a refund, so this
 * is what makes the audit trail name a person. Verification uses jose against
 * the issuer's JWKS: signature (key from the issuer, never from the token),
 * iss and aud, exp/nbf with a little clock skew. The algorithm is pinned
 * because the token header is attacker input.
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
