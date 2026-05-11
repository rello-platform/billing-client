import { BillingError, codeForStatus } from "./errors.js";
/**
 * URL construction — kills the double-`/api` bug class permanently.
 *
 * Spec §URL construction: strip any trailing slash, strip a trailing `/api`
 * if present. Path joined at call time is responsible for the `/api/v1/...`
 * prefix.
 */
export function normalizeApiUrl(raw) {
    let url = raw.trim();
    while (url.endsWith("/"))
        url = url.slice(0, -1);
    if (url.endsWith("/api"))
        url = url.slice(0, -"/api".length);
    while (url.endsWith("/"))
        url = url.slice(0, -1);
    return url;
}
export function authToken(cfg) {
    if (cfg.apiKey)
        return cfg.apiKey;
    if (cfg.appSecret)
        return cfg.appSecret;
    throw new Error("createBillingClient: exactly one of apiKey or appSecret must be provided. " +
        "Provision a DB API key via Rello admin → API Keys for this app, or set RELLO_APP_SECRET as a bootstrap fallback.");
}
function genRequestId() {
    // RFC4122 v4 (lightweight; not for crypto). Falls back if crypto.randomUUID
    // is unavailable for any reason (older runtimes, ESM-only edge contexts).
    const g = globalThis.crypto;
    if (g?.randomUUID)
        return g.randomUUID();
    const b = new Uint8Array(16);
    for (let i = 0; i < 16; i++)
        b[i] = Math.floor(Math.random() * 256);
    // Set version (4) + variant (10xx)
    b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
    b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/**
 * Sleep helper that takes a sleep impl override for tests. The default uses
 * setTimeout via promisified wrapper.
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
const BACKOFF_MS = [250, 500, 1000];
/**
 * Single-request executor. Used for non-retried calls and for each retry attempt.
 * Throws on network/timeout/5xx; returns BillingError for 4xx (so the retry loop
 * can decide whether to bail).
 */
async function executeOnce(baseUrl, cfg, opts, requestId) {
    const url = `${baseUrl}/api/v1${opts.path}`;
    const headers = {
        Authorization: `Bearer ${authToken(cfg)}`,
        "X-Tenant-Id": opts.tenantId,
        "X-App-Slug": cfg.appSlug,
        "X-Request-Id": requestId,
        "Content-Type": "application/json",
    };
    if (opts.idempotencyKey)
        headers["Idempotency-Key"] = opts.idempotencyKey;
    const controller = new AbortController();
    const timeoutMs = cfg.timeoutMs ?? 5_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const doFetch = cfg.fetchImpl ?? fetch;
    try {
        const res = await doFetch(url, {
            method: opts.method,
            headers,
            body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.ok) {
            // 204 No Content → return undefined as the data slot.
            if (res.status === 204) {
                return { ok: true, data: undefined, requestId, status: 204 };
            }
            const data = (await res.json());
            return { ok: true, data, requestId, status: res.status };
        }
        // Non-2xx response.
        let detail = "";
        try {
            detail = await res.text();
        }
        catch {
            // ignore
        }
        const code = codeForStatus(res.status);
        const err = new BillingError(code, res.status, `Rello billing API returned ${res.status} ${res.statusText} for ${opts.method} ${opts.path}${detail ? `: ${detail.slice(0, 500)}` : ""}`, requestId);
        if (res.status >= 500) {
            return { kind: "retryable", cause: err };
        }
        return { ok: false, error: err, requestId };
    }
    catch (caught) {
        clearTimeout(timer);
        const cause = caught;
        return { kind: "retryable", cause };
    }
}
/**
 * Retry loop. Reads: 3 attempts (250/500/1000ms backoff), writes: 2 attempts.
 * Retries on 5xx + network/timeout only. 4xx returns immediately.
 */
export async function executeWithRetries(baseUrl, cfg, opts) {
    const requestId = genRequestId();
    let lastCause;
    for (let attempt = 1; attempt <= opts.attempts; attempt++) {
        const result = await executeOnce(baseUrl, cfg, opts, requestId);
        if ("ok" in result) {
            return result;
        }
        lastCause = result.cause;
        if (attempt < opts.attempts) {
            const backoff = BACKOFF_MS[attempt - 1] ?? 1000;
            await sleep(backoff);
        }
    }
    // All attempts exhausted — convert the final cause into a BillingError.
    const finalErr = (() => {
        if (lastCause instanceof BillingError)
            return lastCause;
        const cause = lastCause;
        const isAbort = cause?.name === "AbortError";
        const code = isAbort ? "BILLING_NETWORK_ERROR" : "BILLING_NETWORK_ERROR";
        return new BillingError(code, 0, `Rello billing API request failed for ${opts.method} ${opts.path}: ${cause?.message ?? "unknown error"}`, requestId);
    })();
    return { ok: false, error: finalErr, requestId };
}
//# sourceMappingURL=fetch.js.map