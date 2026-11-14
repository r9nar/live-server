import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface SessionClaims {
  username: string;
  /** Expiry as epoch milliseconds. */
  exp: number;
}

export interface ExpiringClaims {
  /** Expiry as epoch milliseconds. */
  exp: number;
}

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

/** Signs any JSON claims as `base64url(claims).hmac`. `exp` is required. */
export function signClaims<T extends object>(
  secret: string,
  claims: T & ExpiringClaims,
): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${sign(secret, body)}`;
}

/** Returns the claims when the token is authentic and unexpired, else null. */
export function verifyClaims<T extends object>(
  secret: string,
  token: string,
): (T & ExpiringClaims) | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(secret, body));
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & ExpiringClaims;
    if (!claims || typeof claims !== "object") return null;
    if (typeof claims.exp !== "number" || Date.now() > claims.exp) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Short-lived session token: `base64url(claims).hmac`. */
export function createToken(secret: string, username: string, ttlMs: number): string {
  return signClaims<SessionClaims>(secret, { username, exp: Date.now() + ttlMs });
}

/** Returns the claims when the token is authentic and unexpired, else null. */
export function verifyToken(secret: string, token: string): SessionClaims | null {
  const claims = verifyClaims<SessionClaims>(secret, token);
  if (!claims || typeof claims.username !== "string") return null;
  return claims;
}

export function randomSecret(): string {
  return randomBytes(32).toString("hex");
}
