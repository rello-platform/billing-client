/**
 * Per-process in-memory TTL cache. Keyed by (tenantId, operation).
 * Not shared across instances — that's the intended bound on Rello hiccup
 * blast radius per the binding spec §Cache.
 */
export declare class TtlCache {
    private readonly ttlMs;
    private readonly now;
    private readonly store;
    constructor(ttlMs: number, now?: () => number);
    private key;
    get<T>(tenantId: string, op: string): T | undefined;
    /** Returns the cached value regardless of expiry. Used by fail-open reads. */
    getStale<T>(tenantId: string, op: string): T | undefined;
    set<T>(tenantId: string, op: string, value: T): void;
    clear(): void;
}
//# sourceMappingURL=cache.d.ts.map