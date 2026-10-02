import { TtlCache } from "./cache.js";
import { BillingError } from "./errors.js";
import { authToken, executeWithRetries, generateIdempotencyKey, normalizeApiUrl, } from "./fetch.js";
const DEFAULT_CACHE_TTL_MS = 60_000;
/**
 * The fail-open status — the v0.3.0 permissive default carried into Rello's
 * shape: plan "fail-open-permissive" (the sentinel consumers can test for),
 * status ACTIVE, no subscription/add-ons/usage, every quota null (= no finite
 * quota), exactly as v0.3.0 returned `limits: {}`.
 */
function permissiveStatus(tenantId) {
    return {
        tenant: {
            id: tenantId,
            name: "",
            status: "ACTIVE",
            plan: "fail-open-permissive",
        },
        subscription: null,
        addOns: [],
        usage: [],
        limits: {
            users: null,
            contacts: null,
            emails: null,
            sms: null,
            journeys: null,
            aiDecisions: null,
        },
    };
}
function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
const isStringOrNull = (v) => v === null || typeof v === "string";
/*
 * Guards check the fields that identify each payload — enough that an
 * envelope, an error body, or another route's payload can never pass as
 * `data`. They are not a full schema: a field Rello renames inside a valid
 * payload is caught by the type bump in consumers, not here.
 */
const isStatusData = (d) => isRecord(d) &&
    isRecord(d.tenant) &&
    typeof d.tenant.id === "string" &&
    typeof d.tenant.status === "string" &&
    (d.subscription === null || isRecord(d.subscription)) &&
    Array.isArray(d.addOns) &&
    Array.isArray(d.usage) &&
    isRecord(d.limits);
const isEntitlementsCollection = (d) => isRecord(d) && typeof d.tenantId === "string" && isRecord(d.entitlements);
const isUsageSummary = (d) => isRecord(d) &&
    typeof d.appSlug === "string" &&
    isRecord(d.period) &&
    typeof d.totalRevenueCents === "number" &&
    Array.isArray(d.rows) &&
    Array.isArray(d.allotments);
const isUsageReportResult = (d) => isRecord(d) && d.recorded === true && typeof d.usageRecordId === "string";
const isCheckout = (d) => isRecord(d) && typeof d.sessionId === "string" && isStringOrNull(d.url);
const isPortal = (d) => isRecord(d) && typeof d.url === "string";
const isAddOn = (d) => isRecord(d) &&
    typeof d.tenantAddOnId === "string" &&
    typeof d.status === "string";
const isRemoveAddOn = (d) => isRecord(d) && d.ok === true;
const isCancel = (d) => isRecord(d) && typeof d.status === "string" && isStringOrNull(d.cancelsAt);
const isResume = (d) => isRecord(d) && typeof d.status === "string" && isStringOrNull(d.periodEnd);
const isUpdate = (d) => isRecord(d) &&
    typeof d.status === "string" &&
    isStringOrNull(d.periodEnd) &&
    isRecord(d.proration) &&
    typeof d.proration.prorationDate === "number";
function invalidResponse(operation, opts, result, problem) {
    return new BillingError("BILLING_INVALID_RESPONSE", result.status, `${operation}: Rello returned ${result.status} for ${opts.method} ${opts.path} ${problem}`, result.requestId);
}
/** A 2xx whose body could not be decoded (A-249) → throw naming the call. */
function assertDecoded(operation, opts, result) {
    if (result.decodeError !== undefined) {
        throw invalidResponse(operation, opts, result, result.decodeError);
    }
}
/** Rello's `{ success: true, data }` → `data`, or throw naming the call. */
function readEnvelope(operation, opts, result, isData) {
    assertDecoded(operation, opts, result);
    const body = result.data;
    if (!isRecord(body)) {
        throw invalidResponse(operation, opts, result, "with no JSON object body");
    }
    if (body.success !== true) {
        const detail = typeof body.error === "string" ? `: ${body.error.slice(0, 500)}` : "";
        throw invalidResponse(operation, opts, result, `without success: true (success=${JSON.stringify(body.success) ?? "undefined"})${detail}`);
    }
    if (!isData(body.data)) {
        throw invalidResponse(operation, opts, result, body.data === undefined || body.data === null
            ? "with success: true but no data"
            : "with data that is not this route's payload");
    }
    return body.data;
}
/**
 * A flat (un-enveloped) Rello body → itself, or throw naming the call.
 * Flat routes never send `success`, but a body that explicitly says
 * `success: false` is a failure whatever else it carries (A-250) — it is
 * rejected before the payload guard can accept e.g. `allowed: true` from it.
 * A legitimate `{ allowed: false }` has no `success` key and stays valid.
 */
function readFlat(operation, opts, result, isData) {
    assertDecoded(operation, opts, result);
    const body = result.data;
    if (isRecord(body) && body.success === false) {
        const detail = typeof body.error === "string" ? `: ${body.error.slice(0, 500)}` : "";
        throw invalidResponse(operation, opts, result, `with success: false on a flat route${detail}`);
    }
    if (!isData(result.data)) {
        throw invalidResponse(operation, opts, result, "with a body that is not this route's payload");
    }
    return result.data;
}
const IDEMPOTENCY_KEY_MIN = 8;
const IDEMPOTENCY_KEY_MAX = 128;
/**
 * One key per logical call: the caller's (trimmed, as Rello trims it) when
 * given, else a fresh CSPRNG key. Resolved BEFORE executeWithRetries, so every
 * retry of the call carries the same key. A caller key Rello would 400
 * (idempotency-header.ts: 8–128 chars) throws here, before any request.
 */
function resolveIdempotencyKey(operation, opts) {
    if (opts?.idempotencyKey === undefined)
        return generateIdempotencyKey();
    const raw = opts.idempotencyKey;
    const key = typeof raw === "string" ? raw.trim() : "";
    if (key.length < IDEMPOTENCY_KEY_MIN || key.length > IDEMPOTENCY_KEY_MAX) {
        throw new BillingError("BILLING_INVALID_REQUEST", 400, `${operation}: idempotencyKey must be 8–128 characters after trimming (Rello refuses anything else); got ${typeof raw === "string" ? `${key.length} characters` : typeof raw}.`);
    }
    return key;
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
    /**
     * Run one mutation: resolve its idempotency key once, send it on every
     * attempt, throw on failure, and return Rello's `data`. `clearsCache`
     * invalidates the read caches as soon as Rello reports a 2xx — the
     * mutation happened even if the body then fails the contract check.
     */
    async function mutate(operation, request, idempotencyKey, isData, clearsCache) {
        const fetchOpts = { ...request, idempotencyKey, attempts: 2 };
        const result = await executeWithRetries(baseUrl, cfg, fetchOpts);
        if (!result.ok) {
            reportError(result.error);
            throw result.error;
        }
        if (clearsCache)
            cache.clear();
        try {
            return readEnvelope(operation, fetchOpts, result, isData);
        }
        catch (err) {
            reportError(err);
            throw err;
        }
    }
    return {
        async getStatus(tenantId) {
            const cached = cache.get(tenantId, "status");
            if (cached)
                return cached;
            const fetchOpts = {
                method: "GET",
                path: "/billing/status",
                tenantId,
                attempts: 3,
            };
            const result = await executeWithRetries(baseUrl, cfg, fetchOpts);
            if (result.ok) {
                let data;
                try {
                    data = readEnvelope("getStatus", fetchOpts, result, isStatusData);
                }
                catch (err) {
                    reportError(err);
                    throw err;
                }
                cache.set(tenantId, "status", data);
                return data;
            }
            // Fail-open — unchanged from v0.3.0: any non-2xx or network/timeout
            // failure returns the stale cached value, else the permissive status.
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
            const fetchOpts = {
                method: "GET",
                path: "/entitlements",
                tenantId,
                attempts: 3,
            };
            const result = await executeWithRetries(baseUrl, cfg, fetchOpts);
            if (result.ok) {
                let data;
                try {
                    data = readFlat("getEntitlements", fetchOpts, result, isEntitlementsCollection);
                }
                catch (err) {
                    reportError(err);
                    throw err;
                }
                cache.set(tenantId, "entitlements", data);
                return data;
            }
            reportError(result.error);
            logFailOpen("getEntitlements", tenantId, result.error);
            const stale = cache.getStale(tenantId, "entitlements");
            if (stale)
                return stale;
            return { tenantId, entitlements: {} };
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
            const fetchOpts = {
                method: "GET",
                path: `/billing/usage/summary${qs ? `?${qs}` : ""}`,
                tenantId,
                attempts: 3,
            };
            const result = await executeWithRetries(baseUrl, cfg, fetchOpts);
            if (result.ok) {
                // A 2xx that is not Rello's { success, data } is a contract break, not
                // an outage: it throws rather than rendering as a $0 month.
                let data;
                try {
                    data = readEnvelope("getUsageSummary", fetchOpts, result, isUsageSummary);
                }
                catch (err) {
                    reportError(err);
                    throw err;
                }
                cache.set(tenantId, cacheOp, data);
                return data;
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
            const fetchOpts = {
                method: "GET",
                path: `/entitlements/check?app=${encodeURIComponent(feature)}`,
                tenantId,
                attempts: 3,
            };
            const result = await executeWithRetries(baseUrl, cfg, fetchOpts);
            if (result.ok) {
                // The check route answers flat: { allowed, tier?, ... }. A 2xx without
                // a boolean `allowed` is neither a grant nor a deny — it throws.
                let allowed;
                try {
                    allowed = readFlat("checkAccess", fetchOpts, result, (d) => isRecord(d) && typeof d.allowed === "boolean").allowed;
                }
                catch (err) {
                    reportError(err);
                    throw err;
                }
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
            // Rello's usage route dedupes on the BODY idempotencyKey; the same key
            // rides as X-Idempotency-Key like every other mutation.
            return mutate("reportUsage", { method: "POST", path: "/billing/usage", tenantId, body: usage }, usage.idempotencyKey, isUsageReportResult, false);
        },
        async createCheckoutSession(tenantId, req, opts) {
            const key = resolveIdempotencyKey("createCheckoutSession", opts);
            // Plan checkout reads the key from the BODY (checkout/route.ts:153-176).
            return mutate("createCheckoutSession", {
                method: "POST",
                path: "/billing/checkout",
                tenantId,
                body: { ...req, idempotencyKey: key },
            }, key, isCheckout, false);
        },
        async createPortalSession(tenantId, req, opts) {
            const key = resolveIdempotencyKey("createPortalSession", opts);
            return mutate("createPortalSession", { method: "POST", path: "/billing/portal", tenantId, body: req }, key, isPortal, false);
        },
        async addAddOn(tenantId, req, opts) {
            const key = resolveIdempotencyKey("addAddOn", opts);
            // Clears the read caches — entitlements likely changed.
            return mutate("addAddOn", { method: "POST", path: "/billing/add-on", tenantId, body: req }, key, isAddOn, true);
        },
        async removeAddOn(tenantId, addOnId, opts) {
            const key = resolveIdempotencyKey("removeAddOn", opts);
            return mutate("removeAddOn", {
                method: "DELETE",
                path: `/billing/add-on/${encodeURIComponent(addOnId)}`,
                tenantId,
            }, key, isRemoveAddOn, true);
        },
        async cancelSubscription(tenantId, req, opts) {
            const key = resolveIdempotencyKey("cancelSubscription", opts);
            return mutate("cancelSubscription", {
                method: "POST",
                path: "/billing/subscription/cancel",
                tenantId,
                body: req,
            }, key, isCancel, true);
        },
        async resumeSubscription(tenantId, opts) {
            const key = resolveIdempotencyKey("resumeSubscription", opts);
            return mutate("resumeSubscription", { method: "POST", path: "/billing/subscription/resume", tenantId }, key, isResume, true);
        },
        async updateSubscription(tenantId, req, opts) {
            const key = resolveIdempotencyKey("updateSubscription", opts);
            return mutate("updateSubscription", { method: "PUT", path: "/billing/subscription", tenantId, body: req }, key, isUpdate, true);
        },
    };
}
//# sourceMappingURL=client.js.map