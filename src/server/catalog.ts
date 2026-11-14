import { randomUa } from "../http/ua.js";

export interface SlimGift {
  id: number;
  name: string;
  diamondCount: number;
  icon: string;
}

function firstUrl(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const obj = value as Record<string, unknown>;
  const list = obj.url_list ?? obj.urlList;
  if (Array.isArray(list)) {
    for (const url of list) if (typeof url === "string" && url) return url;
  }
  return "";
}

/**
 * Room gift catalog from TikTok's `webcast/gift/list/` (works unsigned).
 * The raw response is several MB, so it is slimmed and cached per room.
 */
export class GiftCatalog {
  private readonly cache = new Map<string, { expires: number; gifts: SlimGift[] }>();
  private readonly ttlMs: number;
  private readonly timeoutMs: number;

  constructor(ttlMs = 10 * 60_000, timeoutMs = 15_000) {
    this.ttlMs = ttlMs;
    this.timeoutMs = timeoutMs;
  }

  async get(roomId: string): Promise<SlimGift[]> {
    const hit = this.cache.get(roomId);
    if (hit && hit.expires > Date.now()) return hit.gifts;
    const gifts = await this.fetchList(roomId);
    this.remember(roomId, gifts);
    return gifts;
  }

  /** سقف ذاكرة: كل غرفة كتالوجها مئات الهدايا — نحذف المنتهي ثم الأقدم. */
  private remember(roomId: string, gifts: SlimGift[]): void {
    if (this.cache.size >= 100) {
      const now = Date.now();
      for (const [key, entry] of this.cache) {
        if (entry.expires <= now) this.cache.delete(key);
      }
      if (this.cache.size >= 100) {
        const oldest = this.cache.keys().next().value;
        if (oldest) this.cache.delete(oldest);
      }
    }
    this.cache.set(roomId, { expires: Date.now() + this.ttlMs, gifts });
  }

  private async fetchList(roomId: string): Promise<SlimGift[]> {
    const params = new URLSearchParams({
      aid: "1988",
      app_name: "tiktok_web",
      device_platform: "web_pc",
      browser_language: "en-US",
      browser_name: "Mozilla",
      region: "US",
      room_id: roomId,
    });
    const response = await fetch(`https://webcast.tiktok.com/webcast/gift/list/?${params}`, {
      headers: { "User-Agent": randomUa(), Referer: "https://www.tiktok.com/" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = (await response.json()) as { data?: { gifts?: unknown[] } };
    const list = Array.isArray(body.data?.gifts) ? body.data.gifts : [];

    const gifts: SlimGift[] = [];
    for (const raw of list) {
      const gift = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const id = Number(gift.id ?? 0);
      if (!id) continue;
      gifts.push({
        id,
        name: String(gift.name ?? ""),
        diamondCount: Number(gift.diamond_count ?? gift.diamondCount ?? 0),
        icon: firstUrl(gift.image) || firstUrl(gift.icon),
      });
    }
    return gifts;
  }
}
