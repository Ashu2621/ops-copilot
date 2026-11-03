/**
 * Token bucket per caller, in memory.
 *
 * /ask spends real money on every call that reaches the model, so one leaked
 * token shouldn't be able to run up the bill. This is per process; with
 * several replicas the effective limit is N times this. Move it to Redis or
 * the gateway before scaling out.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updated: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  /** Returns 0 if allowed, otherwise seconds until the next token. */
  take(key: string): number {
    const t = this.now();
    let b = this.buckets.get(key);
    if (b) {
      // Re-insert so Map order tracks recency and eviction drops the idlest key.
      this.buckets.delete(key);
    } else {
      if (this.buckets.size >= this.maxKeys) this.evictOldest();
      b = { tokens: this.capacity, updated: t };
    }
    this.buckets.set(key, b);

    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.updated) / 1000) * this.refillPerSec);
    b.updated = t;

    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - b.tokens) / this.refillPerSec);
  }

  private evictOldest(): void {
    const first = this.buckets.keys().next();
    if (!first.done) this.buckets.delete(first.value);
  }
}
