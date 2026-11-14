/**
 * جسر السيرفر اللحظي → الـAPI.
 * السوكت مفيش معاه أي مفاتيح Supabase: كل قراءة/كتابة تمر عبر نقاط داخلية
 * في الـAPI محمية بـ`x-internal-key`، والـAPI هو اللي بيتكلم مع Supabase.
 */

export interface SeenEmote {
  emoteId: string;
  image: string;
  kind?: string;
}

export interface CatalogGift {
  id: string;
  name: string;
  diamonds: number;
  icon: string;
}

export interface StoredCatalog {
  stickers: Array<{ stickerId: string; image: string; kind: string }>;
  gifts: CatalogGift[];
}

/** هوية الودجت المستخلصة من التوكن (بديل `?uid=`). */
export interface WidgetTokenInfo {
  userId: string;
  type: string;
  screen: number;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<FetchResponseLike>;

export interface ApiClientOptions {
  /** عنوان الـAPI، مثال `http://localhost:3000` أو `https://api.tikcraft.com`. */
  url?: string;
  /** المفتاح الداخلي المشترك (`x-internal-key`) — الـAPI بيه بيتأكد إن الطلب جاي من السوكت. */
  key?: string;
  timeoutMs?: number;
  /** مهلة أطول لكتابة/قراءة الكتالوج (قائمة الهدايا كبيرة). */
  catalogTimeoutMs?: number;
  /** مدة كاش التحقق/الاستحقاق (افتراضي 60 ثانية). */
  cacheTtlMs?: number;
  fetchImpl?: FetchLike;
  onLog?: (message: string) => void;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const WIDGET_TOKEN_PATH = "/api/internal/live/widget-token";
const ENTITLEMENT_PATH = "/api/internal/live/entitlement";
const STICKERS_PATH = "/api/internal/live/catalogs/stickers";
const GIFTS_PATH = "/api/internal/live/catalogs/gifts";
const CATALOGS_PATH = "/api/internal/live/catalogs";

const defaultFetch: FetchLike = (input, init) =>
  (globalThis as unknown as { fetch: FetchLike }).fetch(input, init);

export class ApiClient {
  private readonly base: string;
  private readonly key: string;
  private readonly timeoutMs: number;
  private readonly catalogTimeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly log: (message: string) => void;
  private readonly subs = new Map<string, CacheEntry<boolean>>();
  private readonly widgetTokens = new Map<string, CacheEntry<WidgetTokenInfo | null>>();

  constructor(options: ApiClientOptions = {}) {
    this.base = (options.url ?? "").replace(/\/+$/, "");
    this.key = options.key ?? "";
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.catalogTimeoutMs = options.catalogTimeoutMs ?? 15_000;
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.log = options.onLog ?? (() => undefined);
  }

  configured(): boolean {
    return Boolean(this.base && this.key);
  }

  /** يتحقق من توكن ودجت (رابط OBS) ويرجّع هويته — كاش 60 ثانية، والإبطال يظهر بعد الكاش. */
  async resolveWidgetToken(token: string): Promise<WidgetTokenInfo | null> {
    const clean = token.trim();
    if (!clean || !this.configured()) return null;

    const cached = this.widgetTokens.get(clean);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const data = await this.request<{
      widget?: { userId?: string; type?: string; screen?: number };
    }>(WIDGET_TOKEN_PATH, { method: "POST", body: { token: clean } });

    const userId = data?.widget?.userId;
    const info: WidgetTokenInfo | null = userId
      ? {
          userId: String(userId),
          type: String(data?.widget?.type || "widget"),
          screen: Number(data?.widget?.screen) || 1,
        }
      : null;
    this.widgetTokens.set(clean, { value: info, expiresAt: Date.now() + this.cacheTtlMs });
    return info;
  }

  /** هل المستخدم عنده اشتراك نشط؟ (الـAPI هو اللي بيقرأ جدول subscriptions). */
  async hasActiveSubscription(userId: string): Promise<boolean> {
    if (!userId || !this.configured()) return false;

    const cached = this.subs.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const data = await this.request<{ active?: boolean }>(
      `${ENTITLEMENT_PATH}?userId=${encodeURIComponent(userId)}`,
    );
    const active = data?.active === true;
    this.subs.set(userId, { value: active, expiresAt: Date.now() + this.cacheTtlMs });
    return active;
  }

  /** upsert لستيكر واحد لكل المستخدمين المتصلين بالغرفة. */
  async saveStickers(userIds: string[], roomId: string, emotes: SeenEmote[]): Promise<void> {
    const users = userIds.filter(Boolean);
    const valid = emotes.filter((emote) => emote.emoteId && emote.image);
    if (!this.configured() || users.length === 0 || valid.length === 0) return;
    await this.request(STICKERS_PATH, {
      method: "POST",
      body: { userIds: users, roomId, emotes: valid },
      timeoutMs: this.catalogTimeoutMs,
    });
  }

  /** upsert لقائمة هدايا الغرفة عند مستخدم واحد. */
  async saveGifts(userId: string, roomId: string, gifts: CatalogGift[]): Promise<void> {
    const rows = gifts.filter((gift) => gift.id);
    if (!this.configured() || !userId || rows.length === 0) return;
    await this.request(GIFTS_PATH, {
      method: "POST",
      body: { userId, roomId, gifts: rows },
      timeoutMs: this.catalogTimeoutMs,
    });
  }

  /** آخر كتالوج محفوظ للمستخدم (أي غرفة) — عشان يظهر وهو مش متصل. */
  async latest(userId: string): Promise<StoredCatalog & { roomId: string | null }> {
    if (!this.configured() || !userId) return { stickers: [], gifts: [], roomId: null };
    const data = await this.request<{
      roomId?: string | null;
      stickers?: Array<Record<string, unknown>>;
      gifts?: Array<Record<string, unknown>>;
    }>(`${CATALOGS_PATH}/latest?userId=${encodeURIComponent(userId)}`, {
      timeoutMs: this.catalogTimeoutMs,
    });
    return { roomId: data?.roomId ?? null, ...this.mapCatalog(data) };
  }

  /** آخر كتالوج محفوظ للمستخدم+الغرفة (يعمل والغرفة offline). */
  async get(userId: string, roomId: string): Promise<StoredCatalog> {
    if (!this.configured()) return { stickers: [], gifts: [] };
    const data = await this.request<{
      stickers?: Array<Record<string, unknown>>;
      gifts?: Array<Record<string, unknown>>;
    }>(`${CATALOGS_PATH}/${encodeURIComponent(userId)}/${encodeURIComponent(roomId)}`, {
      timeoutMs: this.catalogTimeoutMs,
    });
    return this.mapCatalog(data);
  }

  private mapCatalog(data: {
    stickers?: Array<Record<string, unknown>>;
    gifts?: Array<Record<string, unknown>>;
  } | null): StoredCatalog {
    return {
      stickers: (data?.stickers ?? []).map((row) => ({
        stickerId: String(row.stickerId ?? ""),
        kind: String(row.kind ?? "with_sticker"),
        image: String(row.image ?? ""),
      })),
      gifts: (data?.gifts ?? []).map((row) => ({
        id: String(row.id ?? ""),
        name: String(row.name ?? ""),
        diamonds: Number(row.diamonds ?? 0),
        icon: String(row.icon ?? ""),
      })),
    };
  }

  close(): void {
    this.subs.clear();
    this.widgetTokens.clear();
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown; timeoutMs?: number } = {},
  ): Promise<T | null> {
    if (!this.configured()) return null;
    try {
      const response = await this.fetchImpl(`${this.base}${path}`, {
        method: init.method ?? "GET",
        headers: { "content-type": "application/json", "x-internal-key": this.key },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(init.timeoutMs ?? this.timeoutMs),
      });
      if (!response.ok) {
        this.log(`[api] ${path} failed (${response.status})`);
        return null;
      }
      return (await response.json()) as T;
    } catch (error) {
      this.log(`[api] ${path} error: ${error instanceof Error ? error.message : "unknown"}`);
      return null;
    }
  }
}
