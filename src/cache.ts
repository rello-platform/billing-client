type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

/**
 * Per-process in-memory TTL cache. Keyed by (tenantId, operation).
 * Not shared across instances — that's the intended bound on Rello hiccup
 * blast radius per the binding spec §Cache.
 */
export class TtlCache {
  private readonly store = new Map<string, CacheEntry<unknown>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private key(tenantId: string, op: string): string {
    return `${tenantId}::${op}`;
  }

  get<T>(tenantId: string, op: string): T | undefined {
    const entry = this.store.get(this.key(tenantId, op));
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      // Keep the entry so fail-open reads can fall back via getStale.
      return undefined;
    }
    return entry.value as T;
  }

  /** Returns the cached value regardless of expiry. Used by fail-open reads. */
  getStale<T>(tenantId: string, op: string): T | undefined {
    const entry = this.store.get(this.key(tenantId, op));
    return entry ? (entry.value as T) : undefined;
  }

  set<T>(tenantId: string, op: string, value: T): void {
    this.store.set(this.key(tenantId, op), {
      value,
      expiresAt: this.now() + this.ttlMs,
    });
  }

  clear(): void {
    this.store.clear();
  }
}
