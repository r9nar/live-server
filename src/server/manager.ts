import { TikTokLiveClient } from "../client.js";
import { EventType } from "../events/types.js";
import type { EventTypeName } from "../events/types.js";
import { toSlim } from "../events/slim.js";
import type { SlimEvent } from "../events/slim.js";

/**
 * A downstream client (a socket.io room). The manager only knows this shape, so
 * transports can be swapped without touching the connection logic.
 */
export interface Subscriber {
  /** `json` is a JSON array of slim events (always an array, even for one). */
  sendBatch(json: string): void;
  fail(message: string): void;
  close(): void;
}

export interface SubscriptionHandle {
  close(): void;
}

/** Thrown by `start()` when the upstream limit is reached. */
export class CapacityError extends Error {
  constructor() {
    super("server at capacity");
    this.name = "CapacityError";
  }
}

/**
 * id ثابت للستيكر اللي بييجي جوه رسالة شات بدون `emoteId`:
 * نفس الرابط = نفس الـid، فالحفظ في Supabase بيبقى upsert بدون تكرار.
 */
function stickerIdFromUrl(url: string): string {
  let hash = 5381;
  for (let i = 0; i < url.length; i += 1) {
    hash = ((hash << 5) + hash + url.charCodeAt(i)) >>> 0;
  }
  return `img_${hash.toString(36)}`;
}

export interface ManagerOptions {
  /** Max concurrent upstream TikTok connections (default 200). */
  maxUpstreams?: number;
  /** Close an upstream that has had no subscribers for this long (default 30s). */
  idleMs?: number;
  /** Micro-batch window before flushing to subscribers (default 200ms). */
  batchMs?: number;
  /** Minimum spacing between `roomUser` snapshots per room (default 1000ms). */
  roomUserThrottleMs?: number;
  /** Called once per newly-seen fan emote, for persistence. */
  onEmoteSeen?: (roomId: string, emote: { emoteId: string; image: string }) => void;
  /**
   * Cookie string for the upstream connection (`"sessionid=…; sid_tt=…"`).
   * Optional — anonymous connections work, but a logged-in session unlocks
   * age-restricted rooms and authenticated room data.
   */
  cookies?: () => string | undefined;
  onLog?: (message: string) => void;
}

interface Entry {
  username: string;
  client: TikTokLiveClient;
  roomId?: string;
  subs: Set<Subscriber>;
  buffer: SlimEvent[];
  emotes: Map<string, string>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  ready: Promise<string>;
  lastEventAt: number;
  lastActive: number;
  lastRoomUserAt: number;
  /** Set once a `stream-end` frame arrives; the upstream is closed shortly after. */
  ending: boolean;
  endTimer: ReturnType<typeof setTimeout> | null;
}

const SLIM_EVENTS: EventTypeName[] = [
  EventType.chat,
  EventType.emoteChat,
  EventType.gift,
  EventType.like,
  EventType.member,
  EventType.join,
  EventType.follow,
  EventType.share,
  EventType.social,
  EventType.roomUserSeq,
  EventType.subNotify,
  EventType.subscriptionNotify,
  EventType.subCapsule,
  EventType.subPinEvent,
  EventType.liveEnded,
  EventType.questionNew,
  EventType.roomMessage,
];

/**
 * One upstream TikTok connection per creator, shared by every subscriber.
 * Deduping by username/roomId is the main cost lever: 1000 viewers of one
 * stream consume one TikTok connection, not 1000.
 */
export class ConnectionManager {
  private readonly byUsername = new Map<string, Entry>();
  private readonly byRoom = new Map<string, Entry>();
  private readonly max: number;
  private readonly idleMs: number;
  private readonly batchMs: number;
  private readonly roomUserMs: number;
  private readonly onEmoteSeen?: (roomId: string, emote: { emoteId: string; image: string }) => void;
  private readonly cookies?: () => string | undefined;
  private readonly log: (message: string) => void;
  private readonly sweep: ReturnType<typeof setInterval>;

  constructor(options: ManagerOptions = {}) {
    this.max = options.maxUpstreams ?? 200;
    this.idleMs = options.idleMs ?? 30_000;
    this.batchMs = options.batchMs ?? 200;
    this.roomUserMs = options.roomUserThrottleMs ?? 1_000;
    this.onEmoteSeen = options.onEmoteSeen;
    this.cookies = options.cookies;
    this.log = options.onLog ?? (() => undefined);
    this.sweep = setInterval(() => this.sweepIdle(), 5_000);
    this.sweep.unref();
  }

  /** Attach a subscriber, opening (or reusing) the upstream. Returns null if at capacity. */
  join(username: string, sub: Subscriber): SubscriptionHandle | null {
    let entry = this.byUsername.get(username);
    if (!entry) {
      if (this.byUsername.size >= this.max) return null;
      entry = this.open(username);
      this.byUsername.set(username, entry);
    }
    const active = entry;
    active.subs.add(sub);
    active.lastActive = Date.now();

    active.ready.then(
      (roomId) => {
        if (active.subs.has(sub)) {
          sub.sendBatch(JSON.stringify([{ type: "connected", data: { roomId } }]));
        }
      },
      (err: unknown) => {
        sub.fail(err instanceof Error ? err.message : String(err));
        sub.close();
        active.subs.delete(sub);
        this.remove(active, "connect-failed");
      },
    );

    return { close: () => this.detach(active, sub) };
  }

  /**
   * Open (or reuse) an upstream without a subscriber, e.g. to validate that a
   * creator is live and return the roomId before the client joins the room.
   */
  async start(username: string): Promise<string> {
    let entry = this.byUsername.get(username);
    if (!entry) {
      if (this.byUsername.size >= this.max) throw new CapacityError();
      entry = this.open(username);
      this.byUsername.set(username, entry);
    }
    const active = entry;
    active.lastActive = Date.now();
    try {
      return await active.ready;
    } catch (err) {
      this.remove(active, "start-failed");
      throw err;
    }
  }

  /** Emotes seen in this room so far (from `emoteChat` events — no session needed). */
  getEmotes(roomId: string): Array<{ emoteId: string; image: string }> {
    const entry = this.byRoom.get(roomId);
    if (!entry) return [];
    return [...entry.emotes].map(([emoteId, image]) => ({ emoteId, image }));
  }

  /** Close an upstream immediately (used by the desktop app on disconnect). */
  stop(username: string): void {
    const entry = this.byUsername.get(username);
    if (entry) this.remove(entry, "stopped");
  }

  /** Remove a subscriber; schedules idle shutdown when the last one leaves. */
  private detach(entry: Entry, sub: Subscriber): void {
    entry.subs.delete(sub);
    if (entry.subs.size === 0) entry.lastActive = Date.now();
  }

  stats(): { upstreams: number; subscribers: number; rooms: string[] } {
    let subscribers = 0;
    for (const entry of this.byUsername.values()) subscribers += entry.subs.size;
    return { upstreams: this.byUsername.size, subscribers, rooms: [...this.byRoom.keys()] };
  }

  /** Live state for one creator (`null` when no upstream is open). */
  info(username: string): {
    upstream: boolean;
    subscribers: number;
    roomId: string | null;
    lastEventAt: number | null;
    ending: boolean;
  } | null {
    const entry = this.byUsername.get(username);
    if (!entry) return null;
    return {
      upstream: true,
      subscribers: entry.subs.size,
      roomId: entry.roomId ?? null,
      lastEventAt: entry.lastEventAt,
      ending: entry.ending,
    };
  }

  close(): void {
    clearInterval(this.sweep);
    for (const entry of [...this.byUsername.values()]) this.remove(entry, "shutdown");
  }

  private open(username: string): Entry {
    const client = new TikTokLiveClient(username);
    client.setMaxListeners(0);
    const cookies = this.cookies?.();
    if (cookies) client.cookies(cookies);
    const now = Date.now();
    const entry: Entry = {
      username,
      client,
      subs: new Set(),
      buffer: [],
      emotes: new Map(),
      flushTimer: null,
      ready: Promise.resolve(""),
      lastEventAt: now,
      lastActive: now,
      lastRoomUserAt: 0,
      ending: false,
      endTimer: null,
    };

    for (const type of SLIM_EVENTS) {
      client.on(type, (data: unknown) => this.onEngineEvent(entry, type, data));
    }
    client.on("error", (err: unknown) => {
      this.log(`[${username}] error: ${err instanceof Error ? err.message : String(err)}`);
    });

    entry.ready = client.connect().then((roomId) => {
      entry.roomId = roomId;
      this.byRoom.set(roomId, entry);
      this.log(`[${username}] connected room=${roomId}`);
      return roomId;
    });

    return entry;
  }

  private onEngineEvent(entry: Entry, type: EventTypeName, data: unknown): void {
    entry.lastEventAt = Date.now();
    const slim = toSlim({ type, data });
    if (!slim) return;

    // الستيكر ممكن ييجي كـ`emote` أو جوه `chat` عادي — نتعلم الاتنين
    if (slim.type === "emote" || slim.type === "chat") {
      const image = typeof slim.data.stickerUrl === "string" ? slim.data.stickerUrl : "";
      if (image) {
        const rawId = typeof slim.data.emoteId === "string" ? slim.data.emoteId : "";
        // لو الحدث مامعاهوش id (ستيكر شات) نولّد id ثابت من الرابط — نفس الستيكر = نفس الـid
        const emoteId = rawId || stickerIdFromUrl(image);
        if (!entry.emotes.has(emoteId)) {
          entry.emotes.set(emoteId, image);
          if (entry.roomId) this.onEmoteSeen?.(entry.roomId, { emoteId, image });
        }
      }
    }

    if (slim.type === "roomUser") {
      const now = Date.now();
      if (now - entry.lastRoomUserAt < this.roomUserMs) return;
      entry.lastRoomUserAt = now;
    }

    // Stream ended → flush the final frame, then drop the upstream so it never
    // lingers (and never reconnects) after the broadcast is over.
    if (slim.type === "stream-end" && !entry.ending) {
      entry.ending = true;
      entry.endTimer = setTimeout(() => this.remove(entry, "stream-ended"), this.batchMs + 100);
      entry.endTimer.unref?.();
    }

    if (entry.subs.size === 0) return;
    entry.buffer.push(slim);
    if (!entry.flushTimer) {
      entry.flushTimer = setTimeout(() => this.flush(entry), this.batchMs);
    }
  }

  private flush(entry: Entry): void {
    entry.flushTimer = null;
    if (entry.buffer.length === 0) return;
    const text = JSON.stringify(entry.buffer);
    entry.buffer = [];
    for (const sub of entry.subs) {
      try {
        sub.sendBatch(text);
      } catch {
        entry.subs.delete(sub);
      }
    }
  }

  private sweepIdle(): void {
    const now = Date.now();
    for (const entry of [...this.byUsername.values()]) {
      if (entry.subs.size > 0) continue;
      if (now - entry.lastActive < this.idleMs) continue;
      this.remove(entry, "idle");
    }
  }

  private remove(entry: Entry, reason: string): void {
    if (this.byUsername.get(entry.username) !== entry) return;
    this.byUsername.delete(entry.username);
    if (entry.roomId) this.byRoom.delete(entry.roomId);
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer);
      entry.flushTimer = null;
    }
    if (entry.endTimer) {
      clearTimeout(entry.endTimer);
      entry.endTimer = null;
    }
    for (const sub of entry.subs) sub.close();
    entry.subs.clear();
    try {
      entry.client.disconnect();
    } catch {
      this.log(`[${entry.username}] disconnect failed`);
    }
    this.log(`[${entry.username}] closed (${reason})`);
  }
}
