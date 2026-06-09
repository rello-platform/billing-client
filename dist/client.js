import { TtlCache } from "./cache.js";
import { BillingError } from "./errors.js";
import { authToken, executeWithRetries, normalizeApiUrl } from "./fetch.js";
const DEFAULT_CACHE_TTL_MS = 60_000;
function permissiveStatus(tenantId) {
    return {
        tenantId,
        planSlug: "fail-open-permissive",
        status: "ACTIVE",
        monthlyPriceCents: 0,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        trialEndsAt: null,
        limits: {},
    };
}
function permissiveEntitlement(feature) {
    return {
        feature,
        allowed: true,
        tier: null,
        isTrialing: false,
        isExpired: false,
        limits: {},
        currentUsage: {},
    };
}
const MONTH_LABELS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
/**
 * Safe-empty summary returned on a fail-open read (DL6: a panel must always
 * render — never hard-error on a billing-read miss). Period defaults to the
 * requested month, else the current calendar month. Computed in UTC so the
 * window is deterministic regardless of host timezone.
 */
function emptyUsageSummary(appSlug, opts) {
    const now = new Date();
    const year = opts?.year ?? now.getUTCFullYear();
    const month = opts?.month ?? now.getUTCMonth() + 1;
    const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
    const label = `${MONTH_LABELS[month - 1] ?? `M${month}`} ${year}`;
    return {
        appSlug,
        appName: appSlug,
        period: {
            year,
            month,
            label,
            start: start.toISOString(),
            end: end.toISOString(),
        },
        totalRevenueCents: 0,
        totalRevenueKnown: false,
        recordCount: 0,
        rows: [],
        allotments: [],
        portalAvailable: false,
    };
}
function inferFailOpenReason(err) {
    if (err.code === "BILLING_NETWORK_ERROR") {
        return err.message.toLowerCase().includes("abort") ? "timeout" : "network";
    }
    if (err.code === "BILLING_UPSTREAM_5XX")
        return "upstream_5xx";
    if (err.code === "BILLING_UNAUTHORIZED")
        return "unauthorized";
    return "invalid_response";
}
export function createBillingClient(cfg) {
    // Validate auth presence synchronously per spec §Auth strategy.
    authToken(cfg);
    // One-time warning when only appSecret is present (the DB-key migration nudge).
    if (!cfg.apiKey && cfg.appSecret) {
        // Use console.warn — spoke apps' loggers will pick it up. Single shot per
        // client instance (factory call).
        console.warn(`[@rello-platform/billing-client] Using RELLO_APP_SECRET fallback for appSlug=${cfg.appSlug}. ` +
            "Provision a DB API key for this app via Rello admin → API Keys.");
    }
    const baseUrl = normalizeApiUrl(cfg.apiUrl);
    const cacheTtlMs = cfg.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    const cache = new TtlCache(cacheTtlMs, cfg.now);
    function logFailOpen(operation, tenantId, err) {
        const event = {
            event: "billing_fail_open",
            reason: inferFailOpenReason(err),
            operation,
            tenantId,
            appSlug: cfg.appSlug,
            ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
            detail: err.message,
        };
        if (cfg.onFailOpen) {
            try {
                cfg.onFailOpen(event);
            }
            catch {
                // never let an onFailOpen handler crash the client
            }
        }
        // Structured log line for ops alerting. Per spec §Failure semantics.
        console.warn(`event=billing_fail_open reason=${event.reason} operation=${operation} ` +
            `tenantId=${tenantId} appSlug=${cfg.appSlug}${err.requestId ? ` requestId=${err.requestId}` : ""}`);
    }
    function reportError(err) {
        if (!cfg.onError)
            return;
        try {
            cfg.onError(err);
        }
        catch {
            // never let an onError handler crash the client
        }
    }
    return {
        async getStatus(tenantId) {
            const cached = cache.get(tenantId, "status");
            if (cached)
                return cached;
            const result = await executeWithRetries(baseUrl, cfg, {
                method: "GET",
                path: "/billing/status",
                tenantId,
                attempts: 3,
            });
            if (result.ok) {
                cache.set(tenantId, "status", result.data);
                return result.data;
            }
            reportError(result.error);
            logFailOpen("getStatus", tenantId, result.error);
            const stale = cache.getStale(tenantId, "status");
            if (stale)
                return stale;
            return permissiveStatus(tenantId);
        },
        async getEntitlements(tenantId) {
            const cached = cache.get(tenantId, "entitlements");
            if (cached)
                return cached;
            const result = await executeWithRetries(baseUrl, cfg, {
                method: "GET",
                path: "/entitlements",
                tenantId,
                attempts: 3,
            });
            if (result.ok) {
                cache.set(tenantId, "entitlements", result.data);
                return result.data;
            }
            reportError(result.error);
            logFailOpen("getEntitlements", tenantId, result.error);
            const stale = cache.getStale(tenantId, "entitlements");
            if (stale)
                return stale;
            return [];
        },
        async getUsageSummary(tenantId, opts) {
            // Cache key varies by period so a month switch isn't masked by a hit.
            const cacheOp = `usageSummary::${opts?.year ?? "cur"}-${opts?.month ?? "cur"}`;
            const cached = cache.get(tenantId, cacheOp);
            if (cached)
                return cached;
            const query = new URLSearchParams();
            if (opts?.year != null)
                query.set("year", String(opts.year));
            if (opts?.month != null)
                query.set("month", String(opts.month));
            const qs = query.toString();
            const path = `/billing/usage/summary${qs ? `?${qs}` : ""}`;
            const result = await executeWithRetries(baseUrl, cfg, { method: "GET", path, tenantId, attempts: 3 });
            if (result.ok) {
                // The endpoint wraps the payload as { success, data }. A 200 with a
                // missing/!success body is an invalid response → treat as fail-open.
                if (result.data?.success && result.data.data) {
                    cache.set(tenantId, cacheOp, result.data.data);
                    return result.data.data;
                }
                const malformed = new BillingError("BILLING_INVALID_REQUEST", result.status, `Rello billing API returned ${result.status} with a missing/invalid usage summary body${result.data?.error ? `: ${result.data.error}` : ""}`, result.requestId);
                reportError(malformed);
                logFailOpen("getUsageSummary", tenantId, malformed);
                const stale = cache.getStale(tenantId, cacheOp);
                if (stale)
                    return stale;
                return emptyUsageSummary(cfg.appSlug, opts);
            }
            reportError(result.error);
            logFailOpen("getUsageSummary", tenantId, result.error);
            const stale = cache.getStale(tenantId, cacheOp);
            if (stale)
                return stale;
            return emptyUsageSummary(cfg.appSlug, opts);
        },
        async checkAccess(tenantId, feature) {
            const cacheOp = `checkAccess::${feature}`;
            const cached = cache.get(tenantId, cacheOp);
            if (cached !== undefined)
                return cached;
            // Rello's canonical route (src/app/api/v1/entitlements/check/route.ts)
            // reads searchParams.get("app") and 400s when it's absent — the param
            // MUST be `app`, not `feature` (the v0.2.0 `feature=` form made every
            // spoke's gate 400 → fail-open → silently pass).
            const result = await executeWithRetries(baseUrl, cfg, {
                method: "GET",
                path: `/entitlements/check?app=${encodeURIComponent(feature)}`,
                tenantId,
                attempts: 3,
            });
            if (result.ok) {
                const allowed = Boolean(result.data?.allowed);
                cache.set(tenantId, cacheOp, allowed);
                return allowed;
            }
            reportError(result.error);
            logFailOpen("checkAccess", tenantId, result.error);
            const stale = cache.getStale(tenantId, cacheOp);
            // LOUD failure (Kelly directive 2026-06-09): the fail-open default is
            // policy-pending, but it must never be silent. console.error fires on
            // EVERY failed check — non-ok response and thrown/network error alike
            // (executeWithRetries folds both into result.error).
            console.error("[billing-client] entitlement check failed — failing OPEN", {
                app: feature,
                tenantId,
                status: result.error.status,
                body: result.error.message,
                error: result.error.code,
                ...(result.error.requestId !== undefined
                    ? { requestId: result.error.requestId }
                    : {}),
                fallback: stale !== undefined ? `stale-cache:${stale}` : "permissive-true",
            });
            if (stale !== undefined)
                return stale;
            // Permissive default — spoke app caches second-tier via local
            // BillingSubscription table per spec §Failure semantics.
            return true;
        },
        async reportUsage(tenantId, usage) {
            if (!usage.idempotencyKey) {
                throw new BillingError("BILLING_INVALID_REQUEST", 400, "reportUsage requires an idempotencyKey (Rello dedupes on this).");
            }
            const result = await executeWithRetries(baseUrl, cfg, {
                method: "POST",
                path: "/billing/usage",
                tenantId,
                body: usage,
                idempotencyKey: usage.idempotencyKey,
                attempts: 2,
            });
            if (!result.ok) {
                reportError(result.error);
                throw result.error;
            }
        },
        async createCheckoutSession(tenantId, req) {
            const result = await executeWithRetries(baseUrl, cfg, {
                method: "POST",
                path: "/billing/checkout",
                tenantId,
                body: req,
                attempts: 2,
            });
            if (!result.ok) {
                reportError(result.error);
                throw result.error;
            }
            return result.data;
        },
        async createPortalSession(tenantId, req) {
            const result = await executeWithRetries(baseUrl, cfg, {
                method: "POST",
                path: "/billing/portal",
                tenantId,
                body: req,
                attempts: 2,
            });
            if (!result.ok) {
                reportError(result.error);
                throw result.error;
            }
            return result.data;
        },
        async addAddOn(tenantId, req) {
            const result = await executeWithRetries(baseUrl, cfg, {
                method: "POST",
                path: "/billing/add-on",
                tenantId,
                body: req,
                attempts: 2,
            });
            if (!result.ok) {
                reportError(result.error);
                throw result.error;
            }
            // Invalidate read caches — entitlements likely changed.
            cache.clear();
            return result.data;
        },
        async removeAddOn(tenantId, addOnId) {
            const result = await executeWithRetries(baseUrl, cfg, {
                method: "DELETE",
                path: `/billing/add-on/${encodeURIComponent(addOnId)}`,
                tenantId,
                attempts: 2,
            });
            if (!result.ok) {
                reportError(result.error);
                throw result.error;
            }
            cache.clear();
            return result.data;
        },
        async cancelSubscription(tenantId, req) {
            const result = await executeWithRetries(baseUrl, cfg, {
                method: "POST",
                path: "/billing/subscription/cancel",
                tenantId,
                body: req,
                attempts: 2,
            });
            if (!result.ok) {
                reportError(result.error);
                throw result.error;
            }
            cache.clear();
            return result.data;
        },
        async resumeSubscription(tenantId) {
            const result = await executeWithRetries(baseUrl, cfg, {
                method: "POST",
                path: "/billing/subscription/resume",
                tenantId,
                attempts: 2,
            });
            if (!result.ok) {
                reportError(result.error);
                throw result.error;
            }
            cache.clear();
            return result.data;
        },
        async updateSubscription(tenantId, req) {
            const result = await executeWithRetries(baseUrl, cfg, {
                method: "PUT",
                path: "/billing/subscription",
                tenantId,
                body: req,
                attempts: 2,
            });
            if (!result.ok) {
                reportError(result.error);
                throw result.error;
            }
            cache.clear();
            return result.data;
        },
    };
}
//# sourceMappingURL=client.js.map