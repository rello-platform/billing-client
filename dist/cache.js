/**
 * Per-process in-memory TTL cache. Keyed by (tenantId, operation).
 * Not shared across instances — that's the intended bound on Rello hiccup
 * blast radius per the binding spec §Cache.
 */
export class TtlCache {
    ttlMs;
    now;
    store = new Map();
    constructor(ttlMs, now = () => Date.now()) {
        this.ttlMs = ttlMs;
        this.now = now;
    }
    key(tenantId, op) {
        return `${tenantId}::${op}`;
    }
    get(tenantId, op) {
        const entry = this.store.get(this.key(tenantId, op));
        if (!entry)
            return undefined;
        if (entry.expiresAt <= this.now()) {
            // Keep the entry so fail-open reads can fall back via getStale.
            return undefined;
        }
        return entry.value;
    }
    /** Returns the cached value regardless of expiry. Used by fail-open reads. */
    getStale(tenantId, op) {
        const entry = this.store.get(this.key(tenantId, op));
        return entry ? entry.value : undefined;
    }
    set(tenantId, op, value) {
        this.store.set(this.key(tenantId, op), {
            value,
            expiresAt: this.now() + this.ttlMs,
        });
    }
    clear() {
        this.store.clear();
    }
}
//# sourceMappingURL=cache.js.map