import type { AddOnRequest, AddOnResponse, BillingClientConfig, BillingStatusData, BillingUsageSummary, BillingUsageSummaryOptions, CheckoutSessionRequest, CheckoutSessionResponse, EntitlementsCollection, MutationOptions, PortalSessionRequest, PortalSessionResponse, RemoveAddOnResponse, SubscriptionCancelRequest, SubscriptionCancelResponse, SubscriptionResumeResponse, SubscriptionUpdateRequest, SubscriptionUpdateResponse, UsageReport, UsageReportResult } from "./types.js";
/**
 * Every method returns Rello's payload — the `data` of Rello's
 * `{ success, data }` envelope, or the whole body for the two flat routes
 * (/entitlements, /entitlements/check) — typed to the shape Rello's route
 * actually builds. A 2xx whose body is not that contract (no envelope,
 * `success: false`, missing or malformed `data`) throws a BillingError with
 * code BILLING_INVALID_RESPONSE whose message starts with the method name.
 * An unreadable body never becomes a default.
 *
 * Every mutation sends `X-Idempotency-Key` (see {@link MutationOptions}).
 */
export type BillingClient = {
    /**
     * GET /api/v1/billing/status → Rello's `data`. Cached 60s.
     * Fail-open (unchanged from v0.3.0) on a non-2xx or a network/timeout
     * failure: the last cached value, else a permissive status
     * (`tenant.plan: "fail-open-permissive"`, `status: "ACTIVE"`, no quotas).
     * A 2xx with an invalid body throws.
     */
    getStatus(tenantId: string): Promise<BillingStatusData>;
    /**
     * GET /api/v1/entitlements → `{ tenantId, entitlements }` (flat body).
     * Cached 60s. Fail-open on a non-2xx / network failure: the last cached
     * value, else `{ tenantId, entitlements: {} }`. A 2xx with an invalid body throws.
     */
    getEntitlements(tenantId: string): Promise<EntitlementsCollection>;
    /**
     * GET /api/v1/billing/usage/summary — revenue-only per-app spend summary
     * (PER-APP-BILLING-PANELS). Cached 60s. Fail-open on a non-2xx / network
     * failure: returns a safe-empty summary (no rows/allotments, $0, portal
     * unavailable) so a billing panel never hard-errors on Rello being down.
     * A 2xx with an invalid body throws. Optional `{ year, month }` selects a
     * calendar month (defaults to the current month).
     */
    getUsageSummary(tenantId: string, opts?: BillingUsageSummaryOptions): Promise<BillingUsageSummary>;
    /**
     * Convenience helper — GET /api/v1/entitlements/check?app=<slug> → `allowed`.
     *
     * `feature` IS the canonical hyphenated app slug (Rello's route reads
     * `searchParams.get("app")` and 400s when absent; after Spoke-Slug-Alignment
     * PR 2, `TenantEntitlement.feature` stores the same canonical slug, so the
     * one value serves both names). Fail-open: returns `true` on a non-2xx or
     * network failure, and logs LOUDLY (console.error) on every failure. A 2xx
     * without a boolean `allowed` throws.
     */
    checkAccess(tenantId: string, feature: string): Promise<boolean>;
    /**
     * POST /api/v1/billing/usage — fail-closed. `usage.idempotencyKey` is
     * required; it goes in the body (Rello dedupes on it) and as X-Idempotency-Key.
     */
    reportUsage(tenantId: string, usage: UsageReport): Promise<UsageReportResult>;
    /** POST /api/v1/billing/checkout (plan flow) — fail-closed. The key is also sent as body `idempotencyKey`, which Rello requires. */
    createCheckoutSession(tenantId: string, req: CheckoutSessionRequest, opts?: MutationOptions): Promise<CheckoutSessionResponse>;
    /** POST /api/v1/billing/portal — fail-closed. */
    createPortalSession(tenantId: string, req: PortalSessionRequest, opts?: MutationOptions): Promise<PortalSessionResponse>;
    /** POST /api/v1/billing/add-on — fail-closed. */
    addAddOn(tenantId: string, req: AddOnRequest, opts?: MutationOptions): Promise<AddOnResponse>;
    /** DELETE /api/v1/billing/add-on/:addOnId — fail-closed. */
    removeAddOn(tenantId: string, addOnId: string, opts?: MutationOptions): Promise<RemoveAddOnResponse>;
    /** POST /api/v1/billing/subscription/cancel — fail-closed. */
    cancelSubscription(tenantId: string, req: SubscriptionCancelRequest, opts?: MutationOptions): Promise<SubscriptionCancelResponse>;
    /** POST /api/v1/billing/subscription/resume — fail-closed. */
    resumeSubscription(tenantId: string, opts?: MutationOptions): Promise<SubscriptionResumeResponse>;
    /** PUT /api/v1/billing/subscription — fail-closed. */
    updateSubscription(tenantId: string, req: SubscriptionUpdateRequest, opts?: MutationOptions): Promise<SubscriptionUpdateResponse>;
};
export declare function createBillingClient(cfg: BillingClientConfig): BillingClient;
//# sourceMappingURL=client.d.ts.map