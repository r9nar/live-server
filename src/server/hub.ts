import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { Server, type Socket } from "socket.io";
import type { ConnectionManager, SubscriptionHandle } from "./manager.js";
import type { LiveSession, SessionStore } from "./sessions.js";
import type { GiftCatalog } from "./catalog.js";
import {
  createEventProcessor,
  buildSettingsMessage,
  buildTestEvent,
  FRONT_EVENTS,
} from "./hub-events.js";

type Json = Record<string, unknown>;
type Processor = ReturnType<typeof createEventProcessor>;

interface HubOptions {
  server: HttpServer;
  manager: ConnectionManager;
  sessions: SessionStore;
  gifts: GiftCatalog;
  allowedOrigins: string[];
  /** المفتاح الداخلي المشترك مع الـAPI — يقفل `/internal/*`. */
  internalApiKey?: string;
  /** يتحقق من توكن Supabase المرسل في `auth.token` ويرجّع userId. */
  verifyUser?: (token: string) => Promise<{ id: string } | null>;
  /** يتحقق من توكن الودجت عبر الـAPI ويرجّع هويته (بديل `?uid=`). */
  resolveWidgetToken?: (token: string) => Promise<WidgetIdentity | null>;
  log?: (message: string) => void;
}

interface WidgetIdentity {
  userId: string;
  type: string;
  screen: number;
}

interface Feed {
  sub: SubscriptionHandle;
  processor: Processor;
  session: LiveSession;
}

interface Outgoing {
  to: "user" | "dashboards" | "widget" | "overlay";
  userId: string;
  target?: string | number | null;
  event: string;
  payload: unknown;
}

/** أوامر التحديات المسموح ببثّها — تتحكم في تايمر الودجت. */
const CHALLENGE_EVENTS = [
  "challenge_setup",
  "challenge_start",
  "challenge_pause",
  "challenge_restart",
  "challenge_reset",
];
const CHALLENGE_WIDGETS = ["gift_challenge", "supporters_challenge"];

const userRoom = (userId: string) => `user:${userId}`;
const dashboardRoom = (userId: string) => `dashboard:${userId}`;
const widgetRoom = (userId: string, type: string) => `widget:${type}:${userId}`;
const overlayRoom = (userId: string, screen: string | number) => `overlay:${userId}:${screen}`;

/** مقارنة ثابتة الزمن — المفتاح الداخلي ما يتسرّبش عن طريق توقيت الرد. */
function sameKey(value: string, expected: string): boolean {
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function originMatches(origin: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  for (const entry of allowed) {
    if (entry === origin) return true;
    if (entry.endsWith(":*") && origin.startsWith(entry.slice(0, -1))) return true;
  }
  return false;
}

/** slim event → الشكل اللي معالج الودجتات بيفهمه (نفس الديسكتوب). */
function toLegacy(slim: { type: string; data?: Json }, session: LiveSession) {
  const data = slim.data || {};
  const user = {
    userId: String(data.userId || ""),
    uniqueId: String(data.uniqueId || ""),
    nickname: String(data.nickname || ""),
    avatar: String(data.avatar || ""),
  };
  return {
    type: slim.type,
    eventLabel: slim.type,
    platform: "tiktok",
    source: "live-server",
    timestamp: Date.now(),
    username: session.username,
    roomId: session.roomId,
    user,
    data,
  };
}

function readCookie(header: string | undefined, name: string): string {
  if (!header) return "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return "";
}

function readJson(req: IncomingMessage): Promise<Json> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > 2_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        resolve(parsed && typeof parsed === "object" ? (parsed as Json) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

/**
 * طبقة socket.io: نفس الأحداث اللي كانت بتمشي SSE للوحة،
 * بالإضافة لبروتوكول الودجتات/الأوفرلاي اللي كان في سيرفر الديسكتوب.
 */
export function createHub(options: HubOptions) {
  const { manager, sessions, log = () => undefined } = options;
  const io = new Server(options.server, {
    path: "/socket.io",
    cors: {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        callback(null, originMatches(origin, options.allowedOrigins));
      },
      credentials: true,
      methods: ["GET", "POST"],
    },
    pingInterval: 25_000,
    pingTimeout: 60_000,
  });

  const processors = new Map<string, Processor>();
  /** قراءة فقط لمستخدم مالوش حالة — من غير ما نولّد مليون معالج بأي uid عشوائي. */
  const EMPTY_PROCESSOR = createEventProcessor();
  const feeds = new Map<string, Feed>();
  /** بث انتهى — ما نعيد فتح upstream تلقائيًا إلا بعد طلب اتصال جديد. */
  const ended = new Map<string, number>();
  const screens = new Map<string, { userId: string; screen: string }>();
  const sliderSettings = new Map<string, Json>();
  const musicState = new Map<string, Json>();

  function processorFor(userId: string): Processor {
    let processor = processors.get(userId);
    if (!processor) {
      processor = createEventProcessor();
      processors.set(userId, processor);
    }
    return processor;
  }

  function emitStatus(userId: string, state: string, extra: Json = {}) {
    io.to(userRoom(userId)).emit("live:status", { state, ...extra });
  }

  function send(userId: string, message: Outgoing) {
    if (!userId) return;
    if (message.to === "widget") {
      io.to(widgetRoom(userId, String(message.target || "widget"))).emit(message.event, message.payload);
      return;
    }
    if (message.to === "overlay") {
      io.to(overlayRoom(userId, message.target || 1)).emit(message.event, message.payload);
      return;
    }
    io.to(userRoom(userId)).emit(message.event, message.payload);
  }

  function onBatch(feed: Feed, json: string) {
    let events: Array<{ type: string; data?: Json }>;
    try {
      events = JSON.parse(json) as Array<{ type: string; data?: Json }>;
    } catch {
      return;
    }

    io.to(dashboardRoom(feed.session.userId)).emit("events", events);

    for (const slim of events) {
      if (!slim || typeof slim.type !== "string") continue;
      if (slim.type === "connected") {
        emitStatus(feed.session.userId, "connected", {
          roomId: String(slim.data?.roomId || feed.session.roomId),
          username: feed.session.username,
        });
        continue;
      }

      const { state, messages } = feed.processor.process(
        toLegacy(slim, feed.session),
        feed.session.userId
      );
      for (const message of messages as Outgoing[]) send(feed.session.userId, message);
      if (state) emitStatus(feed.session.userId, state.state, state);

      if (slim.type === "stream-end") {
        const feedEntry = feeds.get(feed.session.userId);
        if (feedEntry) {
          feedEntry.sub.close();
          feeds.delete(feed.session.userId);
          processors.delete(feed.session.userId);
        }
        rememberEnded(feed.session.userId);
        emitStatus(feed.session.userId, "ended", { roomId: feed.session.roomId });
      }
    }
  }

  /** يفتح اشتراك في upstream للجلسة (مرة واحدة لكل مستخدم). */
  function ensureFeed(session: LiveSession): Feed | null {
    const existing = feeds.get(session.userId);
    if (existing) return existing;

    const endedAt = ended.get(session.userId);
    if (endedAt && session.createdAt < endedAt) return null;

    const processor = processorFor(session.userId);
    const feed: Feed = {
      processor,
      session,
      sub: { close: () => undefined },
    };

    const handle = manager.join(session.username, {
      sendBatch: (json: string) => onBatch(feed, json),
      fail: (message: string) => emitStatus(session.userId, "failed", { message }),
      close: () => undefined,
    });

    if (handle) feed.sub = handle;
    feeds.set(session.userId, feed);
    return feed;
  }

  /** ذاكرة إعدادات لكل مستخدم — بسقف بسيط بدل نمو غير محدود. */
  function remember<T>(map: Map<string, T>, key: string, value: T): void {
    map.set(key, value);
    if (map.size > 500) {
      const oldest = map.keys().next().value;
      if (oldest) map.delete(oldest);
    }
  }

  function closeFeed(userId: string, state = "disconnected") {
    const feed = feeds.get(userId);
    if (!feed) return;
    feed.sub.close();
    feeds.delete(userId);
    // حالة المعالج تخصّ بثًا واحدًا — تحريرها يمنع تراكم الذاكرة لكل مستخدم
    processors.delete(userId);
    emitStatus(userId, state);
  }

  /** `ended` ذاكرة مؤقتة فقط — نحدّها بدل ما تكبر مع كل مستخدم مرّ على السيرفر. */
  function rememberEnded(userId: string): void {
    ended.set(userId, Date.now());
    if (ended.size > 500) {
      const oldest = ended.keys().next().value;
      if (oldest) ended.delete(oldest);
    }
  }

  io.use(async (socket, next) => {
    const token = connectionTokenOf(socket);
    const query = socket.handshake.query as Record<string, string | undefined>;
    const clientType = String(query.clientType || "");

    // توكن Supabase (JWT) → هوية المستخدم مباشرة
    if (token && isJwt(token)) {
      const user = await (options.verifyUser?.(token) ?? null);
      if (!user) return next(new Error("authentication error"));
      (socket.data as { userId?: string }).userId = user.id;
      return next();
    }

    // توكن ودجت OBS (نص عشوائي) → هويته من الـAPI
    if (token) {
      const widget = await (options.resolveWidgetToken?.(token) ?? null);
      if (!widget) return next(new Error("invalid or revoked widget token"));
      (socket.data as { widget?: WidgetIdentity }).widget = widget;
      return next();
    }

    // اللوحة لا تتصل بدون توكن — الودجتات/الأوفرلاي ليها مسار `?uid=`/توكن
    if (clientType === "dashboard") return next(new Error("authentication required"));
    next();
  });

  io.on("connection", (socket: Socket) => {
    void registerSocket(socket);
  });

  /** التوكن ييجي في `auth.token` (اللوحة/الودجت الجديد) أو `?t=` (روابط OBS). */
  function connectionTokenOf(socket: Socket): string {
    const auth = socket.handshake.auth as { token?: unknown } | undefined;
    const query = socket.handshake.query as Record<string, string | undefined>;
    return String(auth?.token || query.t || "").trim();
  }

  /** JWT = ثلاث أجزاء مفصولة بنقطة؛ توكن الودجت نص عشوائي. */
  function isJwt(value: string): boolean {
    return value.split(".").length === 3;
  }

  function registerSocket(socket: Socket): void {
    const query = socket.handshake.query as Record<string, string | undefined>;
    const widget = (socket.data as { widget?: WidgetIdentity }).widget ?? null;
    const verifiedUserId = String((socket.data as { userId?: string }).userId || "");
    const clientType = widget ? "widget" : String(query.clientType || "");
    const cookie = readCookie(socket.handshake.headers.cookie, sessions.cookieName);
    const session = verifiedUserId
      ? sessions.forUser(verifiedUserId)
      : cookie
        ? sessions.fromToken(cookie)
        : null;
    /**
     * الهوية المتحققة من التوكن تغلب أي `?uid=`، والودجت له أولوية لأنه
     * بيتفتح من نفس متصفح اللوحة فمن غير كده يتسجّل باسم المستخدم الغلط.
     */
    const explicitId = verifiedUserId ? "" : String(query.uid || query.userId || "");
    const userId = widget?.userId || verifiedUserId || explicitId || session?.userId || "";

    if (!userId) {
      socket.emit("live:status", { state: "failed", message: "authentication required" });
      socket.disconnect(true);
      return;
    }

    socket.join(userRoom(userId));
    if (session) socket.join(dashboardRoom(userId));

    if (session) {
      const feed = ensureFeed(session);
      socket.emit("live:status", {
        state: manager.info(session.username) ? "connected" : "connecting",
        roomId: feed?.session.roomId ?? session.roomId,
        username: session.username,
      });
    }

    if (widget) socket.join(widgetRoom(userId, widget.type));
    // دعم مؤقت للروابط القديمة `?uid=&clientType=widget&type=...`
    else if (clientType === "widget") socket.join(widgetRoom(userId, String(query.type || "widget")));

    if (clientType === "overlay") {
      const screen = String(widget?.screen || query.screen || 1);
      screens.set(socket.id, { userId, screen });
      socket.join(overlayRoom(userId, screen));
    }

    const status = () => {
      const current = session ? manager.info(session.username) : null;
      return {
        state: current ? "connected" : "disconnected",
        uniqueId: session?.username || "",
        roomId: current?.roomId || session?.roomId || "",
        verified: Boolean(current),
      };
    };

    socket.on("get-current-state", (ack?: (value: unknown) => void) => {
      const value = status();
      if (typeof ack === "function") ack(value);
      else socket.emit("get-current-state", value);
    });

    socket.on("joinWidget", (payload: Json = {}, ack?: (value: unknown) => void) => {
      const type = String(payload.type || payload.widgetType || "widget");
      socket.join(widgetRoom(userId, type));
      const result = { ok: true, userId, type };
      socket.emit("widgetJoined", result);
      if (typeof ack === "function") ack(result);
    });

    socket.on("joinOverlay", (payload: Json = {}, ack?: (value: unknown) => void) => {
      const screen = String(payload.screen || 1);
      screens.set(socket.id, { userId, screen });
      socket.join(overlayRoom(userId, screen));
      const result = { success: true, uid: userId, screen };
      if (typeof ack === "function") ack(result);
      else socket.emit("overlay-joined", result);
    });

    socket.on("music_state_update", (payload: Json = {}) => {
      const state = (payload.state || payload) as Json;
      musicState.set(userId, state);
      if (musicState.size > 500) {
        const oldest = musicState.keys().next().value;
        if (oldest) musicState.delete(oldest);
      }
      io.to(userRoom(userId)).emit("music_state", { userId, state });
    });

    for (const name of CHALLENGE_EVENTS) {
      socket.on(name, (payload: Json = {}) => {
        for (const type of CHALLENGE_WIDGETS) {
          io.to(widgetRoom(userId, type)).emit(name, payload);
        }
      });
    }

    socket.on("disconnect", () => screens.delete(socket.id));
  }

  function cors(res: ServerResponse, req: IncomingMessage) {
    const origin = req.headers.origin;
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,x-user-id");
  }

  function json(res: ServerResponse, status: number, body: unknown) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  }

  /** نقاط HTTP الصغيرة اللي الودجتات/اللوحة بتستخدمها. */
  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url || "/", "http://localhost");
    const path = url.pathname;

    /**
     * `/internal/*` مسارات سيرفر↔سيرفر فقط:
     * مفتاح مشترك، وممنوع أي طلب جاي من متصفح (Origin).
     */
    if (path.startsWith("/internal/") || path.startsWith("/api/internal/")) {
      if (req.headers.origin) return json(res, 403, { ok: false, error: "forbidden" }), true;
      const key = String(req.headers["x-internal-key"] || "");
      const expected = options.internalApiKey || "";
      if (!expected || !key || !sameKey(key, expected)) {
        return json(res, 401, { ok: false, error: "internal key required" }), true;
      }
    }

    const isWidgetApi =
      path.startsWith("/api/widget/") ||
      path.startsWith("/api/actions/") ||
      path === "/api/stream/status" ||
      path === "/api/gifts" ||
      path.startsWith("/internal/") ||
      path.startsWith("/api/internal/");
    if (!isWidgetApi) return false;

    cors(res, req);
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return true;
    }

    const uid = String(url.searchParams.get("uid") || url.searchParams.get("userId") || "");
    const match = path.match(/^\/api\/widget\/initial-data\/([^/]+)\/([^/]+)/);
    if (match) {
      const target = decodeURIComponent(match[1]);
      const kind = match[2];
      const processor = processors.get(target) ?? EMPTY_PROCESSOR;
      if (kind === "highest_gift") return json(res, 200, { success: true, data: processor.getHighestGift() }), true;
      if (kind === "last_gift") return json(res, 200, { success: true, data: processor.getLastGift() }), true;
      if (kind === "top_likes") return json(res, 200, { success: true, data: processor.getTopLikes(10) }), true;
      if (kind === "top_rankers") return json(res, 200, { success: true, data: processor.getTopRankers() }), true;
      if (kind === "top_supporters") return json(res, 200, { success: true, data: processor.getSupporters(20) }), true;
      if (kind === "top_gifters") {
        const data = (processor.getSupporters(50) as Json[]).map((item) => ({
          rank: item.rank,
          nickname: item.nickname,
          avatar: item.avatar,
          uniqueId: item.supporter_username,
          score: item.total_diamonds,
        }));
        return json(res, 200, { success: true, data }), true;
      }
      if (kind === "actions_slider") {
        const actions = (processor.getActions(target) as Json[]).filter(
          (action) => action && action.type === "specific_gift" && action.is_enabled !== false
        );
        return json(res, 200, { success: true, data: actions }), true;
      }
    }

    if (path === "/api/widget/actions-slider/settings") {
      const saved = uid ? sliderSettings.get(uid) || {} : {};
      return (
        json(res, 200, {
          success: true,
          settings: { textColor: "#ffffff", glowColor: "#ff3c3c", disabledActionIds: [], ...saved },
        }),
        true
      );
    }

    if (path === "/api/widget/music-player/snapshot") {
      return json(res, 200, { success: true, state: (uid && musicState.get(uid)) || null }), true;
    }

    if (path === "/api/stream/status") {
      const target = String(uid || "");
      const session = target ? sessions.forUser(target) : null;
      const info = session ? manager.info(session.username) : null;
      return (
        json(res, 200, {
          ok: true,
          state: info ? "connected" : "disconnected",
          uniqueId: session?.username || "",
          roomId: info?.roomId || session?.roomId || "",
          verified: Boolean(info),
        }),
        true
      );
    }

    if (path === "/api/gifts") {
      const target = String(uid || "");
      const session = target ? sessions.forUser(target) : null;
      const list = session ? await options.gifts.get(session.roomId).catch(() => []) : [];
      return (
        json(res, 200, {
          success: true,
          gifts: list.map((gift) => ({
            id: gift.id,
            name: gift.name,
            diamond_count: gift.diamondCount,
            image_url: gift.icon,
          })),
        }),
        true
      );
    }

    if (path.startsWith("/api/actions/screens-status/")) {
      const target = decodeURIComponent(path.split("/").pop() || "");
      const list = [1, 2, 3, 4, 5].map((screen) => ({
        screen,
        online: [...screens.values()].some(
          (entry) => entry.userId === target && Number(entry.screen) === screen
        ),
      }));
      return json(res, 200, { success: true, uid: target, screens: list }), true;
    }

    if (req.method !== "POST") return json(res, 404, { ok: false, error: "not found" }), true;

    const body = await readJson(req);

    if (path === "/internal/settings-changed") {
      const target = String(body.userId || uid || "");
      const kind = String(body.kind || "");
      const processor = processorFor(target);
      if (kind === "highest_gift_reset") processor.resetHighestGift();
      if (kind === "heart_me_goal_reset") processor.resetHeartMe();
      const message = (
        buildSettingsMessage as unknown as (input: Record<string, unknown>) => Outgoing | null
      )({
        kind,
        userId: target,
        settings: (body.settings as Json) || {},
        screen: Number(body.screen) || 1,
      });
      if (!message) return json(res, 400, { ok: false, error: "unknown kind" }), true;
      send(target, message as Outgoing);
      return json(res, 200, { ok: true }), true;
    }

    if (path === "/internal/actions/sync") {
      const target = String(body.userId || "");
      const count = processorFor(target).setActions(target, body.actions);
      return json(res, 200, { ok: true, count }), true;
    }

    if (path === "/internal/actions/sync-slider") {
      const target = String(body.userId || "");
      const processor = processorFor(target);
      const others = (processor.getActions(target) as Json[]).filter(
        (item) => item && item.type !== "specific_gift"
      );
      const slider = (Array.isArray(body.actions) ? body.actions : []).map((item) => ({
        ...(item as Json),
        type: "specific_gift",
      }));
      const count = processor.setActions(target, [...others, ...slider]);
      return json(res, 200, { ok: true, count }), true;
    }

    if (path === "/internal/actions-slider-settings-changed") {
      const target = String(body.userId || uid || "");
      if (target) remember(sliderSettings, target, (body.settings as Json) || {});
      send(target, {
        to: "widget",
        userId: target,
        target: "actions_slider",
        event: FRONT_EVENTS.ACTIONS_SLIDER_SETTINGS,
        payload: { settings: body.settings || {}, userId: target },
      } as Outgoing);
      return json(res, 200, { ok: true }), true;
    }

    if (path === "/api/internal/action-changed") {
      const target = String(body.userId || "");
      processorFor(target).upsertAction(target, String(body.type || ""), body.action);
      io.to(userRoom(target)).emit(FRONT_EVENTS.ACTION_CHANGED, body);
      return json(res, 200, { ok: true }), true;
    }

    if (path === "/internal/test-event") {
      const target = String(body.userId || "");
      const event = buildTestEvent(String(body.type || ""));
      if (!event || !target) return json(res, 400, { ok: false, error: "unknown event" }), true;
      const { messages } = processorFor(target).process(event, target);
      for (const message of messages as Outgoing[]) send(target, message);
      return json(res, 200, { ok: true }), true;
    }

    if (path === "/internal/challenge") {
      const target = String(body.userId || body.uid || uid || "");
      const event = String(body.event || "");
      if (!target || !CHALLENGE_EVENTS.includes(event)) {
        return json(res, 400, { ok: false, error: "unknown challenge event" }), true;
      }
      const payload = (body.payload as Json) || {};
      for (const type of CHALLENGE_WIDGETS) {
        io.to(widgetRoom(target, type)).emit(event, payload);
      }
      return json(res, 200, { ok: true }), true;
    }

    if (path === "/internal/alert") {
      const target = String(body.uid || body.userId || "");
      const screen = String(body.screen || 1);
      io.to(overlayRoom(target, screen)).emit(FRONT_EVENTS.ACTION_ALERT, {
        type: String(body.type || "action"),
        ...(body.payload as Json),
      });
      return json(res, 200, { ok: true }), true;
    }

    return json(res, 404, { ok: false, error: "not found" }), true;
  }

  return {
    io,
    handleHttp,
    /** اتصال جديد بنفس الجلسة (إعادة فتح بث بعد انتهائه). */
    reset(session: LiveSession) {
      ended.delete(session.userId);
      ensureFeed(session);
    },
    closeSession(session: LiveSession) {
      closeFeed(session.userId);
    },
    close() {
      for (const feed of feeds.values()) feed.sub.close();
      feeds.clear();
      io.close();
    },
    log,
  };
}

export type Hub = ReturnType<typeof createHub>;
