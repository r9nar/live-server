import { randomUUID } from "node:crypto";
import { signClaims, verifyClaims } from "./token.js";

export interface LiveSession {
  id: string;
  userId: string;
  username: string;
  roomId: string;
  createdAt: number;
  expiresAt: number;
}

interface CookieClaims {
  sid: string;
  sub: string;
  exp: number;
}

export interface SessionStoreOptions {
  secret: string;
  /** Session lifetime (default 12h). */
  ttlMs?: number;
  cookieName?: string;
  /** Adds `Secure` to the cookie (default true; disable on plain HTTP). */
  cookieSecure?: boolean;
  /** Cookie Domain, e.g. `.tikcraft.com`. */
  cookieDomain?: string;
}

export const DEFAULT_COOKIE_NAME = "live_session";
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Server-side session registry: one room per user, addressed by an
 * HttpOnly signed cookie. socket.io reads the same cookie on the handshake.
 */
export class SessionStore {
  private readonly byId = new Map<string, LiveSession>();
  private readonly byUser = new Map<string, string>();
  private readonly secret: string;
  private readonly ttlMs: number;
  private readonly secure: boolean;
  private readonly domain?: string;
  private readonly sweep: ReturnType<typeof setInterval>;
  readonly cookieName: string;

  constructor(options: SessionStoreOptions) {
    this.secret = options.secret;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.cookieName = options.cookieName ?? DEFAULT_COOKIE_NAME;
    this.secure = options.cookieSecure ?? true;
    this.domain = options.cookieDomain;
    this.sweep = setInterval(() => this.sweepExpired(), 60_000);
    this.sweep.unref();
  }

  create(userId: string, username: string, roomId: string): LiveSession {
    const now = Date.now();
    const session: LiveSession = {
      id: randomUUID(),
      userId,
      username,
      roomId,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.byId.set(session.id, session);
    this.byUser.set(userId, session.id);
    return session;
  }

  get(id: string): LiveSession | null {
    const session = this.byId.get(id);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      this.close(session.id);
      return null;
    }
    return session;
  }

  forUser(userId: string): LiveSession | null {
    const id = this.byUser.get(userId);
    return id ? this.get(id) : null;
  }

  close(id: string): void {
    const session = this.byId.get(id);
    if (!session) return;
    this.byId.delete(id);
    if (this.byUser.get(session.userId) === id) this.byUser.delete(session.userId);
  }

  closeForUser(userId: string): void {
    const id = this.byUser.get(userId);
    if (id) this.close(id);
  }

  /** Platform user ids currently watching a room (for per-user persistence). */
  usersForRoom(roomId: string): string[] {
    const users: string[] = [];
    for (const session of this.byId.values()) {
      if (session.roomId === roomId && Date.now() <= session.expiresAt) users.push(session.userId);
    }
    return users;
  }

  /** `Set-Cookie` value for a session. */
  cookie(session: LiveSession): string {
    return `${this.cookieName}=${this.token(session)}${this.attributes(session.expiresAt)}`;
  }

  /** `Set-Cookie` value that clears the session cookie. */
  clearCookie(): string {
    return `${this.cookieName}=${this.attributes(0)}`;
  }

  token(session: LiveSession): string {
    return signClaims<CookieClaims>(this.secret, {
      sid: session.id,
      sub: session.userId,
      exp: session.expiresAt,
    });
  }

  /** Resolves a cookie value back to a live session, or null. */
  fromToken(token: string): LiveSession | null {
    const claims = verifyClaims<CookieClaims>(this.secret, token);
    if (!claims || typeof claims.sid !== "string" || typeof claims.sub !== "string") return null;
    const session = this.get(claims.sid);
    if (!session || session.userId !== claims.sub) return null;
    return session;
  }

  /** Reads a cookie value from a raw `Cookie` header. */
  static readCookie(header: string | undefined, name: string): string | null {
    if (!header) return null;
    for (const part of header.split(";")) {
      const index = part.indexOf("=");
      if (index < 0) continue;
      if (part.slice(0, index).trim() !== name) continue;
      const value = part.slice(index + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
    return null;
  }

  /** Stops the sweeper and drops every session (shutdown). */
  dispose(): void {
    clearInterval(this.sweep);
    this.byId.clear();
    this.byUser.clear();
  }

  private attributes(expiresAt: number): string {
    const maxAge = expiresAt > 0 ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)) : 0;
    const parts = ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
    if (this.secure) parts.push("Secure");
    if (this.domain) parts.push(`Domain=${this.domain}`);
    return `; ${parts.join("; ")}`;
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const session of [...this.byId.values()]) {
      if (now > session.expiresAt) this.close(session.id);
    }
  }
}
