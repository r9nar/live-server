import type { ApiClient } from "./api-client.js";
import type { GiftCatalog } from "./catalog.js";
import type { ConnectionManager } from "./manager.js";

export interface CatalogSyncDeps {
  manager: ConnectionManager;
  gifts: GiftCatalog;
  /** الكتابة بتمر عبر الـAPI — السوكت مفيش معاه مفاتيح Supabase. */
  store: ApiClient;
  onLog?: (message: string) => void;
}

/**
 * Copies what we already know about a room into one user's saved catalog:
 * stickers seen so far in memory, plus the room's gift list.
 */
export async function persistUserCatalog(
  deps: CatalogSyncDeps,
  userId: string,
  roomId: string,
): Promise<void> {
  if (!deps.store.configured() || !userId || userId === "dev") return;

  const emotes = deps.manager.getEmotes(roomId);
  if (emotes.length > 0) {
    const rows = emotes.map((emote) => ({ ...emote, kind: "with_sticker" }));
    await deps.store.saveStickers([userId], roomId, rows);
  }

  try {
    const gifts = await deps.gifts.get(roomId);
    /**
     * نفس الهدية بتظهر أكتر من مرة في رد تيك توك، و`upsert` بنفس المفتاح
     * مرتين في نفس الطلب بيرجّع 500 من Supabase — فبنجمّعها بالـid الأول.
     */
    const byId = new Map<string, { id: string; name: string; diamonds: number; icon: string }>();
    for (const gift of gifts) {
      byId.set(String(gift.id), {
        id: String(gift.id),
        name: gift.name,
        diamonds: gift.diamondCount,
        icon: gift.icon,
      });
    }
    await deps.store.saveGifts(userId, roomId, [...byId.values()]);
  } catch (error) {
    deps.onLog?.(`[catalog] gifts failed: ${error instanceof Error ? error.message : "unknown"}`);
  }
}
