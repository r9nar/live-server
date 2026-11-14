export interface RateLimiterOptions {
  /** Max burst size. */
  capacity: number;
  /** Tokens restored per second. */
  refillPerSec: number;
}

export interface LimitResult {
  ok: boolean;
  retryAfterMs: number;
  remaining: number;
}

interface Bucket {
  tokens: number;
  updated: number;
}

/** In-memory token bucket — no external service needed for a single instance. */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly sweep: ReturnType<typeof setInterval>;

  constructor(private readonly options: RateLimiterOptions) {
    this.sweep = setInterval(() => this.cleanup(), 60_000);
    this.sweep.unref();
  }

  take(key: string, cost = 1): LimitResult {
    const { capacity, refillPerSec } = this.options;
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? { tokens: capacity, updated: now };
    const elapsed = (now - bucket.updated) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSec);
    bucket.updated = now;
    this.buckets.set(key, bucket);

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { ok: true, retryAfterMs: 0, remaining: Math.floor(bucket.tokens) };
    }
    const need = cost - bucket.tokens;
    const retryAfterMs = refillPerSec > 0 ? Math.ceil((need / refillPerSec) * 1000) : 60_000;
    return { ok: false, retryAfterMs, remaining: 0 };
  }

  close(): void {
    clearInterval(this.sweep);
    this.buckets.clear();
  }

  private cleanup(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [key, bucket] of this.buckets) {
      if (bucket.updated < cutoff) this.buckets.delete(key);
    }
  }
}
