import http from "node:http";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CapacityError, ConnectionManager } from "./manager.js";
import type { ManagerOptions } from "./manager.js";
import { createHub } from "./hub.js";
import { randomSecret } from "./token.js";
import { Security } from "./security.js";
import { RateLimiter } from "./rate-limit.js";
import { GiftCatalog } from "./catalog.js";
import { ApiClient } from "./api-client.js";
import { createSupabaseVerifier } from "./supabase-auth.js";
import { persistUserCatalog } from "./catalog-sync.js";

import { SessionStore } from "./sessions.js";
import { RoomLookup, emptySnapshot } from "./room-info.js";
import { UserNotFoundError, HostNotOnlineError, AgeRestrictedError } from "../http/api.js";

export interface LiveServerOptions extends ManagerOptions {
  /** HMAC secret for session tokens; a random one is generated when omitted. */
  secret?: string;
  /** `Access-Control-Allow-Origin` when no allowlist is set (default `*`). */
  corsOrigin?: string;
  /** Browser allowlist, e.g. `["https://tikcraft.com","http://localhost:*"]`. */
  allowedOrigins?: string[];
  giftCacheTtlMs?: number;
  /** Require a verified Supabase user on `/v1` endpoints (default false). */
  requireAuth?: boolean;
  /** Require an active subscription (implies `requireAuth`). */
  requireSubscription?: boolean;
  /** الـAPI الذي يملك مفاتيح Supabase (مثال `http://localhost:3000` أو `https://api.tikcraft.com`). */
  apiUrl?: string;
  /** المفتاح الداخلي المشترك مع الـAPI (`x-internal-key`). */
  internalApiKey?: string;
  /** Supabase URL + anon key — للتحقق من توكن المستخدم داخل السوكت مباشرة. */
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  /** Session cookie lifetime (default 12h). */
  sessionTtlMs?: number;
  /** Add `Secure` to the session cookie (default true). */
  cookieSecure?: boolean;
  /** Cookie Domain, e.g. `.tikcraft.com`. */
  cookieDomain?: string;
  /** Trust the first `x-forwarded-for` hop (default false). */
  trustProxy?: boolean;
  /** Log one JSON line per request. */
  requestLog?: boolean;
  /** Room info cache lifetime (default 30s). */
  roomInfoTtlMs?: number;
}

export interface LiveServer {
  server: http.Server;
  manager: ConnectionManager;
  hub: ReturnType<typeof createHub>;
  listen(port: number, cb?: () => void): http.Server;
  close(): Promise<void>;
}

import {
  bearerToken,
  clientIp,
  codeFor,
  header,
  requestIds,
  sendJson,
  type Failure,
} from "./http-util.js";

const USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;
const MAX_BODY = 10 * 1024;

function cleanUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/^@/, "");
  return USERNAME_RE.test(name) ? name : null;
}

export function createLiveServer(options: LiveServerOptions = {}): LiveServer {
  const secret = options.secret ?? randomSecret();
  const corsOrigin = options.corsOrigin ?? "*";
  const allowedOrigins = options.allowedOrigins ?? [];
  const api = new ApiClient({
    url: options.apiUrl,
    key: options.internalApiKey,
    onLog: options.onLog,
  });
  /** هوية المستخدم من توكن Supabase مباشرة (بدون دورة على الـAPI). */
  const auth = createSupabaseVerifier({ url: options.supabaseUrl, anonKey: options.supabaseAnonKey, onLog: options.onLog });
  const manager = new ConnectionManager({
    ...options,
    onEmoteSeen: (roomId, emote) => {
      const users = sessions.usersForRoom(roomId);
      if (users.length > 0) void api.saveStickers(users, roomId, [emote]);
    },
  });
  const security = new Security({ allowedOrigins });
  const catalog = new GiftCatalog(options.giftCacheTtlMs);
  const requireAuth = options.requireAuth ?? false;
  const requireSubscription = options.requireSubscription ?? false;
  const trustProxy = options.trustProxy ?? false;
  const sessions = new SessionStore({
    secret,
    ttlMs: options.sessionTtlMs,
    cookieSecure: options.cookieSecure,
    cookieDomain: options.cookieDomain,
  });
  const rooms = new RoomLookup({ ttlMs: options.roomInfoTtlMs, cookies: options.cookies });
  /** socket.io hub — created after the HTTP server (real-time + widget API). */
  let hub: ReturnType<typeof createHub> | null = null;
  const metrics = {
    startedAt: Date.now(),
    requests: 0,
    failures: 0,
    rateLimited: 0,
    authFailed: 0,
  };
  const generalLimit = new RateLimiter({ capacity: 120, refillPerSec: 2 });
  const connectLimit = new RateLimiter({ capacity: 10, refillPerSec: 10 / 60 });
  const readLimit = new RateLimiter({ capacity: 10, refillPerSec: 10 / 60 });

  function applyCors(req: IncomingMessage, res: ServerResponse): void {
    const origin = header(req.headers, "origin");
    if (allowedOrigins.length > 0) {
      if (origin && security.originAllowed(req)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
      }
      res.setHeader("Vary", "Origin");
    } else if (origin && corsOrigin === "*") {
      // Dev fallback: echo the caller so credentialed (cookie) requests work.
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
    } else {
      res.setHeader("Access-Control-Allow-Origin", corsOrigin);
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    res.setHeader("Access-Control-Max-Age", "86400");
  }

  function reply(res: ServerResponse, failure: Failure): void {
    if (failure.retryAfterMs) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil(failure.retryAfterMs / 1000))));
    }
    metrics.failures += 1;
    if (failure.status === 429) metrics.rateLimited += 1;
    if (failure.status === 401 || failure.status === 403) metrics.authFailed += 1;
    const requestId = requestIds.get(res);
    sendJson(res, failure.status, {
      error: { code: failure.code ?? codeFor(failure.status), message: failure.error },
      ...(requestId ? { requestId } : {}),
    });
  }

  function enforce(limiter: RateLimiter, req: IncomingMessage): Failure | null {
    const result = limiter.take(clientIp(req, trustProxy));
    if (result.ok) return null;
    return { ok: false, status: 429, error: "rate limited", code: "RATE_LIMITED", retryAfterMs: result.retryAfterMs };
  }

  function readBody(
    req: IncomingMessage,
    res: ServerResponse,
    callback: (raw: string) => void,
  ): void {
    const type = header(req.headers, "content-type").toLowerCase();
    if (type && !type.includes("application/json")) {
      req.resume();
      reply(res, {
        ok: false,
        status: 415,
        error: "content-type must be application/json",
        code: "UNSUPPORTED_MEDIA_TYPE",
      });
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reply(res, { ok: false, status: 413, error: "body too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => callback(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => reply(res, { ok: false, status: 400, error: "read error" }));
  }

  type UserGuard = { ok: true; userId: string } | Failure;

  /** Resolves the caller's Supabase user (`dev` when auth is disabled). */
  async function requireUser(req: IncomingMessage): Promise<UserGuard> {
    if (!requireAuth) {
      // حتى مع تعطيل المصادقة (تطوير): لو الطلب معاه توكن نستخدم هويته الحقيقية،
      // عشان الجلسة/الغرف ما تتسجّلش بـ"dev" وتضيع أحداث المستخدم.
      const token = bearerToken(req);
      if (token && auth.configured()) {
        const user = await auth.verify(token);
        if (user) return { ok: true, userId: user.id };
      }
      return { ok: true, userId: "dev" };
    }
    if (!auth.configured()) {
      return { ok: false, status: 503, error: "auth not configured", code: "AUTH_UNAVAILABLE" };
    }
    const user = await auth.verify(bearerToken(req));
    if (!user) {
      return { ok: false, status: 401, error: "authentication required", code: "AUTH_REQUIRED" };
    }
    return { ok: true, userId: user.id };
  }

  /** Copies what we already know about the room into the user's saved catalog. */
  function persistCatalog(userId: string, roomId: string): void {
    void persistUserCatalog(
      { manager, gifts: catalog, store: api, onLog: options.onLog },
      userId,
      roomId,
    );
  }

  function handleCreateSession(req: IncomingMessage, res: ServerResponse): void {
    readBody(req, res, (raw) => {
      const limited = enforce(connectLimit, req);
      if (limited) return reply(res, limited);
      void createSession(req, res, raw);
    });
  }

  async function createSession(
    req: IncomingMessage,
    res: ServerResponse,
    raw: string,
  ): Promise<void> {
    const user = await requireUser(req);
    if (!user.ok) return reply(res, user);

    if (requireSubscription) {
      if (!api.configured()) {
        reply(res, {
          ok: false,
          status: 503,
          error: "subscription check not configured",
          code: "SUBSCRIPTION_UNAVAILABLE",
        });
        return;
      }
      const active = await api.hasActiveSubscription(user.userId);
      if (!active) {
        reply(res, {
          ok: false,
          status: 402,
          error: "active subscription required",
          code: "SUBSCRIPTION_REQUIRED",
        });
        return;
      }
    }

    let body: { username?: unknown };
    try {
      body = JSON.parse(raw) as { username?: unknown };
    } catch {
      reply(res, { ok: false, status: 400, error: "invalid json" });
      return;
    }
    const username = cleanUsername(body.username);
    if (!username) {
      reply(res, { ok: false, status: 400, error: "invalid username" });
      return;
    }

    const existing = sessions.forUser(user.userId);
    if (existing && existing.username !== username) {
      reply(res, {
        ok: false,
        status: 409,
        error: "one room per user — close the current session first",
        code: "ROOM_LIMIT",
      });
      return;
    }
    if (existing) {
      res.setHeader("Set-Cookie", sessions.cookie(existing));
      sendJson(res, 200, {
        sessionId: existing.id,
        username: existing.username,
        roomId: existing.roomId,
        socketPath: "/socket.io",
        expiresAt: existing.expiresAt,
      });
      hub?.reset(existing);
      void persistCatalog(user.userId, existing.roomId);
      return;
    }

    try {
      const roomId = await manager.start(username);
      const session = sessions.create(user.userId, username, roomId);
      res.setHeader("Set-Cookie", sessions.cookie(session));
      sendJson(res, 200, {
        sessionId: session.id,
        username,
        roomId,
        socketPath: "/socket.io",
        expiresAt: session.expiresAt,
      });
      hub?.reset(session);
      void persistCatalog(user.userId, roomId);
    } catch (err) {
      if (err instanceof CapacityError) {
        reply(res, { ok: false, status: 503, error: "server at capacity" });
        return;
      }
      const name = err instanceof Error ? err.name : "error";
      const message = err instanceof Error ? err.message : "connect failed";
      const status = name === "UserNotFoundError" ? 404 : name === "HostNotOnlineError" ? 409 : 502;
      const code =
        name === "UserNotFoundError"
          ? "USER_NOT_FOUND"
          : name === "HostNotOnlineError"
            ? "USER_NOT_LIVE"
            : "UPSTREAM_ERROR";
      reply(res, { ok: false, status, error: message, code });
    }
  }

  async function handleDeleteSession(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
  ): Promise<void> {
    const user = await requireUser(req);
    if (!user.ok) return reply(res, user);
    const session = sessions.get(id);
    if (!session || session.userId !== user.userId) {
      reply(res, { ok: false, status: 404, error: "session not found" });
      return;
    }
    hub?.closeSession(session);
    sessions.close(id);
    res.setHeader("Set-Cookie", sessions.clearCookie());
    res.statusCode = 204;
    res.end();
  }

  function handleSessionStatus(req: IncomingMessage, res: ServerResponse, id: string): void {
    const cookie = SessionStore.readCookie(header(req.headers, "cookie"), sessions.cookieName);
    const session = cookie ? sessions.fromToken(cookie) : null;
    if (!session || session.id !== id) {
      reply(res, { ok: false, status: 404, error: "session not found" });
      return;
    }
    const live = manager.info(session.username);
    sendJson(res, 200, {
      sessionId: session.id,
      username: session.username,
      roomId: live?.roomId ?? session.roomId,
      expiresAt: session.expiresAt,
      connected: Boolean(live && live.subscribers > 0),
      upstream: Boolean(live),
      ending: Boolean(live?.ending),
      lastEventAt: live?.lastEventAt ?? null,
    });
  }

  /** الجلسة الحالية من الكوكي — الواجهة بتستخدمها بعد إعادة تحميل الصفحة. */
  function handleCurrentSession(req: IncomingMessage, res: ServerResponse): void {
    const cookie = SessionStore.readCookie(header(req.headers, "cookie"), sessions.cookieName);
    const session = cookie ? sessions.fromToken(cookie) : null;
    if (!session) {
      reply(res, { ok: false, status: 404, error: "no active session" });
      return;
    }
    const live = manager.info(session.username);
    sendJson(res, 200, {
      sessionId: session.id,
      username: session.username,
      roomId: live?.roomId ?? session.roomId,
      expiresAt: session.expiresAt,
      connected: Boolean(live),
      socketPath: "/socket.io",
    });
  }

  /** Room info (nickname/avatar/title/viewers) before opening a session. */
  async function handleRoomInfo(
    req: IncomingMessage,
    res: ServerResponse,
    rawSegment: string,
  ): Promise<void> {
    const limited = enforce(readLimit, req);
    if (limited) return reply(res, limited);

    const user = await requireUser(req);
    if (!user.ok) return reply(res, user);

    let raw = rawSegment;
    try {
      raw = decodeURIComponent(rawSegment);
    } catch {
      // keep the raw segment
    }
    const username = cleanUsername(raw);
    if (!username) {
      reply(res, { ok: false, status: 400, error: "invalid username", code: "VALIDATION" });
      return;
    }

    try {
      sendJson(res, 200, await rooms.get(username));
    } catch (err) {
      if (err instanceof HostNotOnlineError) {
        sendJson(res, 200, emptySnapshot(username));
        return;
      }
      if (err instanceof UserNotFoundError) {
        reply(res, { ok: false, status: 404, error: err.message, code: "USER_NOT_FOUND" });
        return;
      }
      if (err instanceof AgeRestrictedError) {
        reply(res, { ok: false, status: 403, error: err.message, code: "AGE_RESTRICTED" });
        return;
      }
      reply(res, {
        ok: false,
        status: 502,
        error: err instanceof Error ? err.message : "lookup failed",
        code: "UPSTREAM_ERROR",
      });
    }
  }

  /** Saved gifts + stickers for this user + room (works while the room is offline). */
  async function handleRoomCatalog(
    req: IncomingMessage,
    res: ServerResponse,
    roomId: string,
  ): Promise<void> {
    const limited = enforce(readLimit, req);
    if (limited) return reply(res, limited);

    const user = await requireUser(req);
    if (!user.ok) return reply(res, user);
    if (!api.configured()) {
      reply(res, { ok: false, status: 503, error: "catalog store not configured", code: "CATALOG_UNAVAILABLE" });
      return;
    }
    const saved = await api.get(user.userId, roomId);
    sendJson(res, 200, {
      roomId,
      stickers: saved.stickers,
      gifts: saved.gifts,
      savedAt: Date.now(),
    });
  }

  /** آخر كتالوج محفوظ للمستخدم في أي غرفة (للعرض وهو offline). */
  async function handleLatestCatalog(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const limited = enforce(readLimit, req);
    if (limited) return reply(res, limited);

    const user = await requireUser(req);
    if (!user.ok) return reply(res, user);
    if (!api.configured()) {
      reply(res, { ok: false, status: 503, error: "catalog store not configured", code: "CATALOG_UNAVAILABLE" });
      return;
    }
    const saved = await api.latest(user.userId);
    sendJson(res, 200, {
      roomId: saved.roomId,
      stickers: saved.stickers,
      gifts: saved.gifts,
      savedAt: Date.now(),
    });
  }

  function handleMetrics(res: ServerResponse): void {
    const stats = manager.stats();
    sendJson(res, 200, {
      ok: true,
      uptimeMs: Date.now() - metrics.startedAt,
      requests: metrics.requests,
      failures: metrics.failures,
      rateLimited: metrics.rateLimited,
      authFailed: metrics.authFailed,
      realtime: {
        clients: hub?.io.engine.clientsCount ?? 0,
      },
      upstreams: stats.upstreams,
      subscribers: stats.subscribers,
      rooms: stats.rooms.length,
      rssBytes: process.memoryUsage().rss,
    });
  }

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    applyCors(req, res);
    const requestId = randomUUID();
    res.setHeader("X-Request-Id", requestId);
    requestIds.set(res, requestId);
    metrics.requests += 1;
    if (options.requestLog) {
      const startedAt = Date.now();
      res.on("finish", () => {
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            requestId,
            method: req.method,
            path: (req.url ?? "").split("?")[0],
            status: res.statusCode,
            ms: Date.now() - startedAt,
          }),
        );
      });
    }
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    // الدومين المصرّح به فقط: رفض قبل أي تنفيذ (مش مجرد منع قراءة الرد)
    if (allowedOrigins.length > 0 && security.rejectForeignOrigin(req)) {
      return reply(res, { ok: false, status: 403, error: "origin not allowed", code: "ORIGIN_NOT_ALLOWED" });
    }

    const url = new URL(req.url ?? "/", "http://localhost");

    // معدّل الاستخدام لكل IP — مسارات السيرفر↔السيرفر محمية بمفتاح داخلي بدل الحد ده
    const internalCall =
      url.pathname.startsWith("/internal/") || url.pathname.startsWith("/api/internal/");
    if (!internalCall) {
      const limited = enforce(generalLimit, req);
      if (limited) return reply(res, limited);
    }

    // ودجتات/أوفرلاي: نقاط HTTP الخاصة بيها
    if (hub && (await hub.handleHttp(req, res))) return;

    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
      const stats = manager.stats();
      sendJson(res, 200, { ok: true, upstreams: stats.upstreams, subscribers: stats.subscribers });
      return;
    }
    if (req.method === "GET" && (url.pathname === "/v1/metrics" || url.pathname === "/stats")) {
      return handleMetrics(res);
    }
    if (req.method === "GET" && url.pathname.startsWith("/v1/rooms/")) {
      const rest = url.pathname.slice("/v1/rooms/".length);
      const [segment, tail] = rest.split("/");
      if (segment && tail === "catalog") return void handleRoomCatalog(req, res, segment);
      if (segment && !tail) return void handleRoomInfo(req, res, segment);
    }
    if (req.method === "GET" && url.pathname === "/v1/catalogs/latest") {
      return void handleLatestCatalog(req, res);
    }
    if (req.method === "POST" && url.pathname === "/v1/sessions") return handleCreateSession(req, res);
    // مسارات قديمة اتشالت — التطبيق بياخد كل حاجة من socket.io
    if (req.method === "GET" && ["/v1/events", "/v1/gifts", "/v1/emotes"].includes(url.pathname)) {
      reply(res, { ok: false, status: 410, error: "removed — use /socket.io", code: "USE_SOCKET_IO" });
      return;
    }
    if (url.pathname.startsWith("/v1/sessions/")) {
      const id = url.pathname.slice("/v1/sessions/".length);
      if (req.method === "GET" && id === "current") return handleCurrentSession(req, res);
      if (req.method === "DELETE" && id) return void handleDeleteSession(req, res, id);
      if (req.method === "GET" && id) return handleSessionStatus(req, res, id);
    }
    reply(res, { ok: false, status: 404, error: "not found" });
  });

  hub = createHub({
    server,
    manager,
    sessions,
    gifts: catalog,
    allowedOrigins,
    internalApiKey: options.internalApiKey,
    verifyUser: (token: string) => auth.verify(token),
    resolveWidgetToken: (token: string) => api.resolveWidgetToken(token),
    log: options.onLog,
  });

  return {
    server,
    manager,
    hub,
    listen(port: number, cb?: () => void): http.Server {
      return server.listen(port, cb);
    },
    close(): Promise<void> {
      hub?.close();
      manager.close();
      api.close(); auth.close();
      sessions.dispose();
      rooms.close();
      generalLimit.close();
      connectLimit.close();
      readLimit.close();
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
