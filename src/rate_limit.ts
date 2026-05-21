interface Bucket {
  tokens: number;
  lastRefill: number;
}

const CLEANUP_INTERVAL_MS = 60_000;
const STALE_THRESHOLD_MS = 120_000;

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private maxTokens: number;
  private refillRate: number; // tokens per millisecond
  private cleanupTimer: number;

  constructor(maxTokens: number, windowMs: number) {
    this.maxTokens = maxTokens;
    this.refillRate = maxTokens / windowMs;

    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  allow(key: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(key);

    if (!bucket) {
      this.buckets.set(key, { tokens: this.maxTokens - 1, lastRefill: now });
      return true;
    }

    const elapsed = now - bucket.lastRefill;
    bucket.tokens = Math.min(
      this.maxTokens,
      bucket.tokens + elapsed * this.refillRate,
    );
    bucket.lastRefill = now;

    if (bucket.tokens < 1) return false;

    bucket.tokens -= 1;
    return true;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > STALE_THRESHOLD_MS) {
        this.buckets.delete(key);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.buckets.clear();
  }
}

// 30 challenge requests per minute per source IP
export const challengeLimiter = new RateLimiter(30, 60_000);

// 10 theme writes per minute per signing address
export const writeLimiter = new RateLimiter(10, 60_000);

// 300 read requests per minute per source IP
export const readLimiter = new RateLimiter(300, 60_000);
