import type { AddOnRequest, AddOnResponse, BillingClientConfig, BillingStatus, CheckoutSessionRequest, CheckoutSessionResponse, Entitlement, PortalSessionRequest, PortalSessionResponse, RemoveAddOnResponse, SubscriptionCancelRequest, SubscriptionCancelResponse, SubscriptionResumeResponse, SubscriptionUpdateRequest, SubscriptionUpdateResponse, UsageReport } from "./types.js";
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
    createCheckoutSession(tenantId: string, req: CheckoutSessionRequest): Promise<CheckoutSessionResponse>;
    /** POST /api/v1/billing/portal — fail-closed. */
    createPortalSession(tenantId: string, req: PortalSessionRequest): Promise<PortalSessionResponse>;
    /** POST /api/v1/billing/add-on — fail-closed. */
    addAddOn(tenantId: string, req: AddOnRequest): Promise<AddOnResponse>;
    /** DELETE /api/v1/billing/add-on/:addOnId — fail-closed. */
    removeAddOn(tenantId: string, addOnId: string): Promise<RemoveAddOnResponse>;
    /** POST /api/v1/billing/subscription/cancel — fail-closed. */
    cancelSubscription(tenantId: string, req: SubscriptionCancelRequest): Promise<SubscriptionCancelResponse>;
    /** POST /api/v1/billing/subscription/resume — fail-closed. */
    resumeSubscription(tenantId: string): Promise<SubscriptionResumeResponse>;
    /** PUT /api/v1/billing/subscription — fail-closed. */
    updateSubscription(tenantId: string, req: SubscriptionUpdateRequest): Promise<SubscriptionUpdateResponse>;
};
export declare function createBillingClient(cfg: BillingClientConfig): BillingClient;
//# sourceMappingURL=client.d.ts.map