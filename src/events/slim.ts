import { EventType } from "./types.js";
import type { TikTokEvent } from "./types.js";

type Json = Record<string, unknown>;

/** Minimal user object the app needs on every overlay. */
export interface SlimUser {
  userId: string;
  uniqueId: string;
  nickname: string;
  /** Single avatar URL (the raw event carries 6+ signed URLs per image). */
  avatar: string;
}

/** Projected event: only the fields a client consumes. */
export interface SlimEvent {
  type: string;
  data: Json;
}

/** First URL of a TikTok `Image` — a client only needs one. */
function firstUrl(image: unknown): string {
  if (!image || typeof image !== "object") return "";
  const list = (image as Json).urlList;
  if (Array.isArray(list)) {
    for (const url of list) if (typeof url === "string" && url) return url;
  }
  return "";
}

/**
 * الستيكر بييجي متداخل: `EmoteData { emote: { emoteId, image } }`.
 * بنفكّ المستوى ده وبنرجع الشكل المسطّح لو كان أصلاً مسطّح.
 */
function unwrapEmote(raw: unknown): Json {
  const item = (raw && typeof raw === "object" ? raw : {}) as Json;
  const emote = item.emote;
  return (emote && typeof emote === "object" ? emote : item) as Json;
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** Trim a raw `User` down to id / handle / name / one avatar. */
export function slimUser(raw: unknown): SlimUser {
  const user = (raw && typeof raw === "object" ? raw : {}) as Json;
  return {
    userId: str(user.id ?? user.idStr),
    uniqueId: str(user.uniqueId),
    nickname: str(user.nickname),
    avatar:
      firstUrl(user.avatarThumb) ||
      firstUrl(user.avatarMedium) ||
      firstUrl(user.avatarLarge) ||
      firstUrl(user.avatarJpg),
  };
}

/**
 * Project a decoded engine event onto the slim app contract.
 *
 * The engine still decodes the full protobuf (needed for logic and for events
 * we don't know yet), but only this shape goes over the wire to clients.
 * Events the app doesn't render return `null` and are dropped.
 */
export function toSlim(event: TikTokEvent): SlimEvent | null {
  const d = (event.data ?? {}) as Json;

  switch (event.type) {
    case EventType.chat: {
      const user = d.user as Json | undefined;
      const identity = d.userIdentity as Json | undefined;
      const emotes = Array.isArray(d.emotes) ? (d.emotes as Json[]) : [];
      const emote = emotes.length > 0 ? unwrapEmote(emotes[0]) : null;
      const stickerUrl = firstUrl(emote?.image);
      return {
        type: "chat",
        data: {
          ...slimUser(user),
          comment: str(d.content),
          msgId: str((d.common as Json | undefined)?.msgId),
          isModerator: Boolean(identity?.isModeratorOfAnchor),
          isSubscriber: Boolean(identity?.isSubscriberOfAnchor),
          isFollower:
            Boolean(identity?.isFollowerOfAnchor) ||
            Boolean(identity?.isMutualFollowingWithAnchor) ||
            Boolean(user?.isFollower) ||
            num(user?.followStatus) >= 1,
          // ستيكر جوه رسالة شات عادية — لازم الـid عشان نمنع التكرار عند الحفظ
          ...(emote?.emoteId != null ? { emoteId: str(emote.emoteId) } : {}),
          ...(stickerUrl ? { stickerUrl } : {}),
        },
      };
    }

    case EventType.emoteChat: {
      const list = Array.isArray(d.emoteList) ? (d.emoteList as Json[]) : [];
      const emote = list.length > 0 ? unwrapEmote(list[0]) : null;
      const stickerUrl = firstUrl(emote?.image);
      return {
        type: "emote",
        data: {
          ...slimUser(d.user),
          comment: "",
          ...(emote?.emoteId != null ? { emoteId: str(emote.emoteId) } : {}),
          ...(stickerUrl ? { stickerUrl } : {}),
        },
      };
    }

    case EventType.gift: {
      const gift = d.gift as Json | undefined;
      return {
        type: "gift",
        data: {
          ...slimUser(d.user),
          giftId: num(d.giftId),
          giftName: str(gift?.name),
          diamondCount: num(gift?.diamondCount),
          repeatCount: Math.max(num(d.repeatCount, 1), 1),
          repeatEnd: Boolean(d.repeatEnd),
          groupId: str(d.groupId),
          giftPictureUrl: firstUrl(gift?.image) || firstUrl(gift?.icon),
        },
      };
    }

    case EventType.like:
      return {
        type: "like",
        data: {
          ...slimUser(d.user),
          likeCount: Math.max(num(d.count, 1), 1),
          totalLikeCount: num(d.total),
        },
      };

    case EventType.follow:
    case EventType.share:
    case EventType.social:
      return { type: event.type, data: { ...slimUser(d.user) } };

    case EventType.join:
    case EventType.member:
      return { type: event.type, data: { ...slimUser(d.user), actionId: num(d.action) } };

    case EventType.roomUserSeq: {
      const ranks = Array.isArray(d.ranksList) ? (d.ranksList as Json[]) : [];
      return {
        type: "roomUser",
        data: {
          viewerCount: num(d.viewerCount),
          totalUser: num(d.totalUser),
          popularity: num(d.popularity),
          ranksList: ranks.map((entry) => ({
            rank: num(entry.rank),
            score: num(entry.score),
            ...slimUser(entry.user),
          })),
        },
      };
    }

    case EventType.subNotify:
    case EventType.subscriptionNotify:
    case EventType.subCapsule:
    case EventType.subPinEvent:
      return {
        type: "subscribe",
        data: { ...slimUser(d.user ?? d.sender), subMonth: num(d.subMonth, 1) },
      };

    case EventType.liveEnded:
      return { type: "stream-end", data: {} };

    case EventType.questionNew: {
      const details = d.details as Json | undefined;
      return {
        type: "questionNew",
        data: { ...slimUser(details?.user), questionText: str(details?.questionText) },
      };
    }

    case EventType.roomMessage:
      return { type: "room", data: { content: str(d.content) } };

    // Everything else (control, rank, poll, battles, blobs…) is not rendered.
    default:
      return null;
  }
}
