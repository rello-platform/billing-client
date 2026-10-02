import { BillingError } from "./errors.js";
import type { BillingClientConfig } from "./types.js";
/**
 * URL construction — kills the double-`/api` bug class permanently.
 *
 * Spec §URL construction: strip any trailing slash, strip a trailing `/api`
 * if present. Path joined at call time is responsible for the `/api/v1/...`
 * prefix.
 */
export declare function normalizeApiUrl(raw: string): string;
export declare function authToken(cfg: BillingClientConfig): string;
/**
 * A fresh idempotency key for one logical mutation. Rello's
 * BillingIdempotencyKey.key is unique ACROSS tenants and a cached result is
 * replayed to whoever presents the key, so the key must be unguessable:
 * CSPRNG only, never Math.random.
 */
export declare function generateIdempotencyKey(): string;
export type FetchOptions = {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    tenantId: string;
    body?: unknown;
    /** Sent as X-Idempotency-Key on every attempt. */
    idempotencyKey?: string;
    /** "read" gets 3 attempts; "write" gets 2. */
    attempts: 1 | 2 | 3;
    /** Allow retry on these status families. Default: 5xx + network only. */
    retryOn4xx?: boolean;
};
export type FetchResult<T> = {
    ok: true;
    data: T;
    requestId: string;
    status: number;
};
export type FetchFailure = {
    ok: false;
    error: BillingError;
    requestId: string;
};
/**
 * Retry loop. Reads: 3 attempts (250/500/1000ms backoff), writes: 2 attempts.
 * Retries on 5xx + network/timeout only. 4xx returns immediately.
 */
export declare function executeWithRetries<T>(baseUrl: string, cfg: BillingClientConfig, opts: FetchOptions): Promise<FetchResult<T> | FetchFailure>;
//# sourceMappingURL=fetch.d.ts.map