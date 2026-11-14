/**
 * التحقق من توكن Supabase داخل السوكت مباشرة — بدون المرور على الـAPI.
 * نستخدم `anon key` (مفتاح عام، مش service role) ونفس نقطة Supabase الرسمية
 * `GET /auth/v1/user`، مع كاش على مستوى التوكن نفسه.
 */

export interface SupabaseUser {
  id: string;
  email?: string;
}

export interface SupabaseVerifierOptions {
  url?: string;
  anonKey?: string;
  /** مدة كاش التوكن (افتراضي 60 ثانية). */
  cacheTtlMs?: number;
  timeoutMs?: number;
  onLog?: (message: string) => void;
}

interface CacheEntry {
  user: SupabaseUser | null;
  expiresAt: number;
}

const MAX_CACHE = 5000;

export interface SupabaseVerifier {
  configured(): boolean;
  verify(token: string): Promise<SupabaseUser | null>;
  close(): void;
}

export function createSupabaseVerifier(options: SupabaseVerifierOptions = {}): SupabaseVerifier {
  const base = String(options.url || "").replace(/\/+$/, "");
  const anonKey = String(options.anonKey || "");
  const cacheTtlMs = options.cacheTtlMs ?? 60_000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const log = options.onLog ?? (() => undefined);
  const cache = new Map<string, CacheEntry>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [token, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(token);
    }
  }, 60_000);
  sweep.unref();

  function configured(): boolean {
    return Boolean(base && anonKey);
  }

  function remember(token: string, user: SupabaseUser | null): void {
    if (cache.size >= MAX_CACHE) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(token, { user, expiresAt: Date.now() + cacheTtlMs });
  }

  async function verify(token: string): Promise<SupabaseUser | null> {
    if (!token || !configured()) return null;

    const cached = cache.get(token);
    if (cached && cached.expiresAt > Date.now()) return cached.user;

    try {
      const response = await fetch(`${base}/auth/v1/user`, {
        headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        remember(token, null);
        return null;
      }
      const data = (await response.json()) as { user?: { id?: string; email?: string } } | { id?: string; email?: string };
      const candidate = (data as { user?: { id?: string; email?: string } }).user ?? (data as { id?: string; email?: string });
      const user: SupabaseUser | null = candidate?.id
        ? { id: String(candidate.id), email: candidate.email }
        : null;
      remember(token, user);
      return user;
    } catch (error) {
      log(`[supabase] verify failed: ${error instanceof Error ? error.message : "unknown"}`);
      return null;
    }
  }

  return {
    configured,
    verify,
    close() {
      clearInterval(sweep);
      cache.clear();
    },
  };
}
