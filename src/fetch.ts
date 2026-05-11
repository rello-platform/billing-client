import { BillingError, codeForStatus } from "./errors.js";
import type { BillingClientConfig } from "./types.js";

/**
 * URL construction — kills the double-`/api` bug class permanently.
 *
 * Spec §URL construction: strip any trailing slash, strip a trailing `/api`
 * if present. Path joined at call time is responsible for the `/api/v1/...`
 * prefix.
 */
export function normalizeApiUrl(raw: string): string {
  let url = raw.trim();
  while (url.endsWith("/")) url = url.slice(0, -1);
  if (url.endsWith("/api")) url = url.slice(0, -"/api".length);
  while (url.endsWith("/")) url = url.slice(0, -1);
  return url;
}

export function authToken(cfg: BillingClientConfig): string {
  if (cfg.apiKey) return cfg.apiKey;
  if (cfg.appSecret) return cfg.appSecret;
  throw new Error(
    "createBillingClient: exactly one of apiKey or appSecret must be provided. " +
      "Provision a DB API key via Rello admin → API Keys for this app, or set RELLO_APP_SECRET as a bootstrap fallback.",
  );
}

function genRequestId(): string {
  // RFC4122 v4 (lightweight; not for crypto). Falls back if crypto.randomUUID
  // is unavailable for any reason (older runtimes, ESM-only edge contexts).
  const g = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (g?.randomUUID) return g.randomUUID();
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  // Set version (4) + variant (10xx)
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type FetchOptions = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  tenantId: string;
  body?: unknown;
  idempotencyKey?: string;
  /** "read" gets 3 attempts; "write" gets 2. */
  attempts: 1 | 2 | 3;
  /** Allow retry on these status families. Default: 5xx + network only. */
  retryOn4xx?: boolean;
};

/**
 * Sleep helper that takes a sleep impl override for tests. The default uses
 * setTimeout via promisified wrapper.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const BACKOFF_MS = [250, 500, 1000];

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
 * Single-request executor. Used for non-retried calls and for each retry attempt.
 * Throws on network/timeout/5xx; returns BillingError for 4xx (so the retry loop
 * can decide whether to bail).
 */
async function executeOnce<T>(
  baseUrl: string,
  cfg: BillingClientConfig,
  opts: FetchOptions,
  requestId: string,
): Promise<FetchResult<T> | FetchFailure | { kind: "retryable"; cause: BillingError | Error }> {
  const url = `${baseUrl}/api/v1${opts.path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${authToken(cfg)}`,
    "X-Tenant-Id": opts.tenantId,
    "X-App-Slug": cfg.appSlug,
    "X-Request-Id": requestId,
    "Content-Type": "application/json",
  };
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

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
        return { ok: true, data: undefined as T, requestId, status: 204 };
      }
      const data = (await res.json()) as T;
      return { ok: true, data, requestId, status: res.status };
    }

    // Non-2xx response.
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
    const code = codeForStatus(res.status);
    const err = new BillingError(
      code,
      res.status,
      `Rello billing API returned ${res.status} ${res.statusText} for ${opts.method} ${opts.path}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
      requestId,
    );

    if (res.status >= 500) {
      return { kind: "retryable", cause: err };
    }
    return { ok: false, error: err, requestId };
  } catch (caught) {
    clearTimeout(timer);
    const cause = caught as Error;
    return { kind: "retryable", cause };
  }
}

/**
 * Retry loop. Reads: 3 attempts (250/500/1000ms backoff), writes: 2 attempts.
 * Retries on 5xx + network/timeout only. 4xx returns immediately.
 */
export async function executeWithRetries<T>(
  baseUrl: string,
  cfg: BillingClientConfig,
  opts: FetchOptions,
): Promise<FetchResult<T> | FetchFailure> {
  const requestId = genRequestId();
  let lastCause: BillingError | Error | undefined;

  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    const result = await executeOnce<T>(baseUrl, cfg, opts, requestId);
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
    if (lastCause instanceof BillingError) return lastCause;
    const cause = lastCause;
    const isAbort = (cause as { name?: string } | undefined)?.name === "AbortError";
    const code = isAbort ? "BILLING_NETWORK_ERROR" : "BILLING_NETWORK_ERROR";
    return new BillingError(
      code,
      0,
      `Rello billing API request failed for ${opts.method} ${opts.path}: ${cause?.message ?? "unknown error"}`,
      requestId,
    );
  })();

  return { ok: false, error: finalErr, requestId };
}
