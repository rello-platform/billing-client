import { TtlCache } from "./cache.js";
import { BillingError } from "./errors.js";
import { authToken, executeWithRetries, normalizeApiUrl } from "./fetch.js";
import type {
  AddOnRequest,
  AddOnResponse,
  BillingClientConfig,
  BillingStatus,
  CheckoutSessionRequest,
  CheckoutSessionResponse,
  Entitlement,
  FailOpenEvent,
  FailOpenReason,
  PortalSessionRequest,
  PortalSessionResponse,
  RemoveAddOnResponse,
  SubscriptionCancelRequest,
  SubscriptionCancelResponse,
  SubscriptionResumeResponse,
  SubscriptionUpdateRequest,
  SubscriptionUpdateResponse,
  UsageReport,
} from "./types.js";

export type BillingClient = {
  /** GET /api/v1/billing/status — cached 60s. Fail-open. */
  getStatus(tenantId: string): Promise<BillingStatus>;
  /** GET /api/v1/billing/entitlements — cached 60s. Fail-open. */
  getEntitlements(tenantId: string): Promise<Entitlement[]>;
  /** Convenience helper. Fail-open: returns `true` on any non-explicit deny. */
  checkAccess(tenantId: string, feature: string): Promise<boolean>;

  /** POST /api/v1/billing/usage — fail-closed (throws BillingError on error). */
  reportUsage(tenantId: string, usage: UsageReport): Promise<void>;
  /** POST /api/v1/billing/checkout — fail-closed. */
  createCheckoutSession(
    tenantId: string,
    req: CheckoutSessionRequest,
  ): Promise<CheckoutSessionResponse>;
  /** POST /api/v1/billing/portal — fail-closed. */
  createPortalSession(
    tenantId: string,
    req: PortalSessionRequest,
  ): Promise<PortalSessionResponse>;
  /** POST /api/v1/billing/add-on — fail-closed. */
  addAddOn(tenantId: string, req: AddOnRequest): Promise<AddOnResponse>;
  /** DELETE /api/v1/billing/add-on/:addOnId — fail-closed. */
  removeAddOn(tenantId: string, addOnId: string): Promise<RemoveAddOnResponse>;
  /** POST /api/v1/billing/subscription/cancel — fail-closed. */
  cancelSubscription(
    tenantId: string,
    req: SubscriptionCancelRequest,
  ): Promise<SubscriptionCancelResponse>;
  /** POST /api/v1/billing/subscription/resume — fail-closed. */
  resumeSubscription(tenantId: string): Promise<SubscriptionResumeResponse>;
  /** PUT /api/v1/billing/subscription — fail-closed. */
  updateSubscription(
    tenantId: string,
    req: SubscriptionUpdateRequest,
  ): Promise<SubscriptionUpdateResponse>;
};

const DEFAULT_CACHE_TTL_MS = 60_000;

function permissiveStatus(tenantId: string): BillingStatus {
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

function permissiveEntitlement(feature: string): Entitlement {
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

function inferFailOpenReason(err: BillingError): FailOpenReason {
  if (err.code === "BILLING_NETWORK_ERROR") {
    return err.message.toLowerCase().includes("abort") ? "timeout" : "network";
  }
  if (err.code === "BILLING_UPSTREAM_5XX") return "upstream_5xx";
  if (err.code === "BILLING_UNAUTHORIZED") return "unauthorized";
  return "invalid_response";
}

export function createBillingClient(cfg: BillingClientConfig): BillingClient {
  // Validate auth presence synchronously per spec §Auth strategy.
  authToken(cfg);

  // One-time warning when only appSecret is present (the DB-key migration nudge).
  if (!cfg.apiKey && cfg.appSecret) {
    // Use console.warn — spoke apps' loggers will pick it up. Single shot per
    // client instance (factory call).
    console.warn(
      `[@rello-platform/billing-client] Using RELLO_APP_SECRET fallback for appSlug=${cfg.appSlug}. ` +
        "Provision a DB API key for this app via Rello admin → API Keys.",
    );
  }

  const baseUrl = normalizeApiUrl(cfg.apiUrl);
  const cacheTtlMs = cfg.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cache = new TtlCache(cacheTtlMs, cfg.now);

  function logFailOpen(
    operation: string,
    tenantId: string,
    err: BillingError,
  ): void {
    const event: FailOpenEvent = {
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
      } catch {
        // never let an onFailOpen handler crash the client
      }
    }
    // Structured log line for ops alerting. Per spec §Failure semantics.
    console.warn(
      `event=billing_fail_open reason=${event.reason} operation=${operation} ` +
        `tenantId=${tenantId} appSlug=${cfg.appSlug}${
          err.requestId ? ` requestId=${err.requestId}` : ""
        }`,
    );
  }

  function reportError(err: Error): void {
    if (!cfg.onError) return;
    try {
      cfg.onError(err);
    } catch {
      // never let an onError handler crash the client
    }
  }

  return {
    async getStatus(tenantId) {
      const cached = cache.get<BillingStatus>(tenantId, "status");
      if (cached) return cached;

      const result = await executeWithRetries<BillingStatus>(baseUrl, cfg, {
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
      const stale = cache.getStale<BillingStatus>(tenantId, "status");
      if (stale) return stale;
      return permissiveStatus(tenantId);
    },

    async getEntitlements(tenantId) {
      const cached = cache.get<Entitlement[]>(tenantId, "entitlements");
      if (cached) return cached;

      const result = await executeWithRetries<Entitlement[]>(baseUrl, cfg, {
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
      const stale = cache.getStale<Entitlement[]>(tenantId, "entitlements");
      if (stale) return stale;
      return [];
    },

    async checkAccess(tenantId, feature) {
      const cacheOp = `checkAccess::${feature}`;
      const cached = cache.get<boolean>(tenantId, cacheOp);
      if (cached !== undefined) return cached;

      const result = await executeWithRetries<{ allowed: boolean }>(
        baseUrl,
        cfg,
        {
          method: "GET",
          path: `/entitlements/check?feature=${encodeURIComponent(feature)}`,
          tenantId,
          attempts: 3,
        },
      );
      if (result.ok) {
        const allowed = Boolean(result.data?.allowed);
        cache.set(tenantId, cacheOp, allowed);
        return allowed;
      }

      reportError(result.error);
      logFailOpen("checkAccess", tenantId, result.error);
      const stale = cache.getStale<boolean>(tenantId, cacheOp);
      if (stale !== undefined) return stale;
      // Permissive default — spoke app caches second-tier via local
      // BillingSubscription table per spec §Failure semantics.
      return true;
    },

    async reportUsage(tenantId, usage) {
      if (!usage.idempotencyKey) {
        throw new BillingError(
          "BILLING_INVALID_REQUEST",
          400,
          "reportUsage requires an idempotencyKey (Rello dedupes on this).",
        );
      }
      const result = await executeWithRetries<{ ok: true }>(baseUrl, cfg, {
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
      const result = await executeWithRetries<CheckoutSessionResponse>(
        baseUrl,
        cfg,
        {
          method: "POST",
          path: "/billing/checkout",
          tenantId,
          body: req,
          attempts: 2,
        },
      );
      if (!result.ok) {
        reportError(result.error);
        throw result.error;
      }
      return result.data;
    },

    async createPortalSession(tenantId, req) {
      const result = await executeWithRetries<PortalSessionResponse>(
        baseUrl,
        cfg,
        {
          method: "POST",
          path: "/billing/portal",
          tenantId,
          body: req,
          attempts: 2,
        },
      );
      if (!result.ok) {
        reportError(result.error);
        throw result.error;
      }
      return result.data;
    },

    async addAddOn(tenantId, req) {
      const result = await executeWithRetries<AddOnResponse>(baseUrl, cfg, {
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
      const result = await executeWithRetries<RemoveAddOnResponse>(
        baseUrl,
        cfg,
        {
          method: "DELETE",
          path: `/billing/add-on/${encodeURIComponent(addOnId)}`,
          tenantId,
          attempts: 2,
        },
      );
      if (!result.ok) {
        reportError(result.error);
        throw result.error;
      }
      cache.clear();
      return result.data;
    },

    async cancelSubscription(tenantId, req) {
      const result = await executeWithRetries<SubscriptionCancelResponse>(
        baseUrl,
        cfg,
        {
          method: "POST",
          path: "/billing/subscription/cancel",
          tenantId,
          body: req,
          attempts: 2,
        },
      );
      if (!result.ok) {
        reportError(result.error);
        throw result.error;
      }
      cache.clear();
      return result.data;
    },

    async resumeSubscription(tenantId) {
      const result = await executeWithRetries<SubscriptionResumeResponse>(
        baseUrl,
        cfg,
        {
          method: "POST",
          path: "/billing/subscription/resume",
          tenantId,
          attempts: 2,
        },
      );
      if (!result.ok) {
        reportError(result.error);
        throw result.error;
      }
      cache.clear();
      return result.data;
    },

    async updateSubscription(tenantId, req) {
      const result = await executeWithRetries<SubscriptionUpdateResponse>(
        baseUrl,
        cfg,
        {
          method: "PUT",
          path: "/billing/subscription",
          tenantId,
          body: req,
          attempts: 2,
        },
      );
      if (!result.ok) {
        reportError(result.error);
        throw result.error;
      }
      cache.clear();
      return result.data;
    },
  };
}
