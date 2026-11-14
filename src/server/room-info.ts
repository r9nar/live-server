import { checkOnline, fetchRoomInfoJson } from "../http/api.js";
import { fetchProfileStats } from "../http/profile.js";

export interface RoomSnapshot {
  username: string;
  roomId: string | null;
  nickname: string;
  avatar: string;
  title: string;
  viewerCount: number;
  likeCount: number;
  totalUser: number;
  /** متابعين صاحب البث — متاحين لما `room/info` يشتغل (بيحتاج كوكيز في غرف 18+). */
  followers: number | null;
  isLive: boolean;
  fetchedAt: number;
}

/** Snapshot returned when a creator is not currently live (still HTTP 200). */
export function emptySnapshot(username: string): RoomSnapshot {
  return {
    username,
    roomId: null,
    nickname: username,
    avatar: "",
    title: "",
    viewerCount: 0,
    likeCount: 0,
    totalUser: 0,
    followers: null,
    isLive: false,
    fetchedAt: Date.now(),
  };
}

function pickAvatar(user: Record<string, unknown>): string {
  for (const key of ["avatar_thumb", "avatar_medium", "avatar_larger"]) {
    const image = user[key] as { url_list?: unknown } | undefined;
    const list = image?.url_list;
    if (Array.isArray(list) && typeof list[0] === "string") return list[0];
  }
  const flat = user.avatar_url ?? user.avatarUrl;
  return typeof flat === "string" ? flat : "";
}

/** Maps `/webcast/room/info/` JSON to the fields the dashboard needs. */
export function mapRoomInfo(
  username: string,
  roomId: string,
  body: Record<string, unknown>,
): RoomSnapshot {
  const data = (body.data ?? {}) as Record<string, unknown>;
  const stats = (data.stats ?? {}) as Record<string, unknown>;
  const user = (data.user ?? data.owner ?? {}) as Record<string, unknown>;
  const followInfo = (user.followInfo ?? {}) as Record<string, unknown>;
  const followers = Number(followInfo.followerCount ?? stats.follower_count ?? 0);

  return {
    username,
    roomId,
    nickname: String(user.nickname ?? username),
    avatar: pickAvatar(user),
    title: String(data.title ?? ""),
    viewerCount: Number(data.user_count ?? 0),
    likeCount: Number(stats.like_count ?? 0),
    totalUser: Number(stats.total_user ?? 0),
    followers: followers > 0 ? followers : null,
    isLive: true,
    fetchedAt: Date.now(),
  };
}

export interface RoomLookupOptions {
  /** Cache lifetime per username (default 30s). */
  ttlMs?: number;
  timeoutMs?: number;
  /** كوكيز تيك توك — بدونها `room/info` بيرفض غرف 18+. */
  cookies?: () => string | undefined;
}

/** Resolves a creator's live room info (nickname, avatar, title, viewers). */
export class RoomLookup {
  private readonly cache = new Map<string, { value: RoomSnapshot; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly cookies?: () => string | undefined;
  private readonly sweep: ReturnType<typeof setInterval>;

  constructor(options: RoomLookupOptions = {}) {
    this.ttlMs = options.ttlMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.cookies = options.cookies;
    this.sweep = setInterval(() => this.sweepExpired(), 60_000);
    this.sweep.unref();
  }

  async get(username: string): Promise<RoomSnapshot> {
    const cached = this.cache.get(username);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    // الاسم والصورة والعنوان من نفس رد `checkOnline` — متاحين حتى للغرف 18+.
    // وإحصائيات البروفايل (المتابعين) من صفحة `embed` بالتوازي.
    const [{ roomId, nickname, avatar, title }, stats] = await Promise.all([
      checkOnline(username, this.timeoutMs),
      fetchProfileStats(username, this.timeoutMs),
    ]);

    let snapshot: RoomSnapshot = {
      username,
      roomId,
      nickname: nickname || stats?.nickname || username,
      avatar: avatar || stats?.avatar || "",
      title,
      viewerCount: 0,
      likeCount: 0,
      totalUser: 0,
      followers: stats?.followers ?? null,
      isLive: true,
      fetchedAt: Date.now(),
    };

    try {
      const info = mapRoomInfo(
        username,
        roomId,
        await fetchRoomInfoJson(roomId, this.timeoutMs, this.cookies?.() ?? ""),
      );
      snapshot = {
        ...info,
        nickname: nickname || info.nickname,
        avatar: avatar || info.avatar,
        title: title || info.title,
        followers: info.followers ?? stats?.followers ?? null,
      };
    } catch {
      // غرف 18+: `room/info` بيطلب كوكي — بنكمل ببيانات `checkOnline` + البروفايل.
    }

    this.cache.set(username, { value: snapshot, expiresAt: Date.now() + this.ttlMs });
    return snapshot;
  }

  close(): void {
    clearInterval(this.sweep);
    this.cache.clear();
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt < now) this.cache.delete(key);
    }
  }
}
