/**
 * Canonical response types for the Rello v1 billing API.
 *
 * Rule E (PLATFORM-CLASS-LEVEL-RULES): consumers (Rello API routes, spoke
 * apps, hooks) MUST import these types from here — never redeclare locally.
 * Drift between this contract and a redeclared `interface` becomes a silent
 * NaN/undefined at runtime, not a compile error.
 */
export type BillingSubscriptionStatus = "ACTIVE" | "TRIAL" | "PAST_DUE" | "CHURNED" | "SUSPENDED";
export type BillingStatus = {
    tenantId: string;
    planSlug: string;
    status: BillingSubscriptionStatus;
    monthlyPriceCents: number;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    trialEndsAt: string | null;
    limits: Record<string, number>;
};
export type Entitlement = {
    feature: string;
    allowed: boolean;
    tier: string | null;
    isTrialing: boolean;
    isExpired: boolean;
    limits: Record<string, number>;
    currentUsage: Record<string, number>;
};
export type UsageReport = {
    metric: string;
    quantity: number;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
};
/**
 * PER-APP-BILLING-PANELS — canonical home for the GET
 * /api/v1/billing/usage/summary response contract. Mirrors Rello's
 * `BillingUsageSummaryData` (src/app/api/v1/billing/usage/summary/route.ts)
 * VERBATIM — structurally identical so the panel UI and the spoke callers all
 * read one shape. REVENUE-ONLY (DL1): there is intentionally no `costCents`
 * field — margin/cost is admin-only internal data, never exposed here.
 */
/** Calendar-month window the summary is scoped to. */
export type BillingUsageSummaryPeriod = {
    year: number;
    month: number;
    /** Human label, e.g. "May 2026". */
    label: string;
    /** ISO start of the calendar month. */
    start: string;
    /** ISO end of the calendar month (last day, 23:59:59.999). */
    end: string;
};
/** A single (metric × service) revenue-only line for the period. */
export type BillingUsageSummaryRow = {
    appSlug: string;
    appName: string;
    metric: string;
    metricName: string;
    unit: string | null;
    service: string | null;
    quantity: number;
    /** Revenue charged to the tenant for this line; null when unknown. */
    revenueCents: number | null;
    revenueKnown: boolean;
};
/**
 * Metric-level allotment view (DL3). Only present for metrics that map to a
 * FINITE plan quota; unlimited/no-quota metrics surface as raw `rows` only.
 */
export type BillingUsageAllotment = {
    metric: string;
    metricName: string;
    /** Tenant-plan quota ceiling for the metric (finite). */
    included: number;
    /** This app's used quantity of the metric for the period. */
    used: number;
    /** max(included - used, 0). */
    remaining: number;
    /** Σ revenueCents charged for this metric on this app; null if unknown. */
    overageCents: number | null;
};
export type BillingUsageSummary = {
    /** Canonical lowercase appSlug this summary is scoped to. */
    appSlug: string;
    /** App display name; falls back to the raw appSlug. */
    appName: string;
    period: BillingUsageSummaryPeriod;
    /** Σ revenueCents across all rows for the period — integer cents (DL1). */
    totalRevenueCents: number;
    /** True iff any row carried a known revenueCents value (else UI shows "—"). */
    totalRevenueKnown: boolean;
    /** Number of UsageRecord rows aggregated for the period. */
    recordCount: number;
    /** Per (metric × service) breakdown, sorted by revenueCents desc. */
    rows: BillingUsageSummaryRow[];
    /** Metric-level allotment, where a finite plan quota exists (DL3). */
    allotments: BillingUsageAllotment[];
    /** DL4 — whether the panel can link the existing Stripe customer portal. */
    portalAvailable: boolean;
};
/** Optional period selector for getUsageSummary. Defaults to current month. */
export type BillingUsageSummaryOptions = {
    year?: number;
    month?: number;
};
export type CheckoutSessionRequest = {
    planSlug: string;
    successUrl: string;
    cancelUrl: string;
};
export type CheckoutSessionResponse = {
    url: string;
    sessionId: string;
};
export type PortalSessionRequest = {
    returnUrl: string;
};
export type PortalSessionResponse = {
    url: string;
};
export type AddOnRequest = {
    addOnId: string;
    quantity?: number;
};
export type AddOnResponse = {
    tenantAddOnId: string;
    status: string;
};
export type RemoveAddOnResponse = {
    ok: true;
};
export type SubscriptionCancelRequest = {
    atPeriodEnd: boolean;
};
export type SubscriptionCancelResponse = {
    cancelsAt: string | null;
    status: string;
};
export type SubscriptionResumeResponse = {
    status: string;
    periodEnd: string;
};
export type SubscriptionUpdateRequest = {
    planSlug: string;
    billingCycle?: "MONTHLY" | "ANNUAL";
};
export type SubscriptionUpdateResponse = {
    status: string;
    periodEnd: string;
    proration: number;
};
export type WebhookEventType = "billing.subscription_changed" | "billing.addon_changed" | "billing.invoice_paid" | "billing.invoice_failed" | "billing.trial_ending" | "billing.entitlement_changed";
export type WebhookEvent = {
    id: string;
    type: "billing.subscription_changed";
    tenantId: string;
    data: BillingStatus;
} | {
    id: string;
    type: "billing.addon_changed";
    tenantId: string;
    data: {
        addOnId: string;
        status: "ADDED" | "REMOVED";
    };
} | {
    id: string;
    type: "billing.invoice_paid";
    tenantId: string;
    data: {
        invoiceId: string;
        amountCents: number;
    };
} | {
    id: string;
    type: "billing.invoice_failed";
    tenantId: string;
    data: {
        invoiceId: string;
        reason: string;
    };
} | {
    id: string;
    type: "billing.trial_ending";
    tenantId: string;
    data: {
        trialEndsAt: string;
    };
} | {
    id: string;
    type: "billing.entitlement_changed";
    tenantId: string;
    data: Entitlement;
};
export type BillingErrorCode = "BILLING_UNAUTHORIZED" | "BILLING_NOT_FOUND" | "BILLING_CONFLICT" | "BILLING_RATE_LIMITED" | "BILLING_UPSTREAM_5XX" | "BILLING_NETWORK_ERROR" | "BILLING_INVALID_REQUEST";
export type FailOpenReason = "network" | "timeout" | "upstream_5xx" | "unauthorized" | "invalid_response";
export type FailOpenEvent = {
    event: "billing_fail_open";
    reason: FailOpenReason;
    operation: string;
    tenantId: string;
    appSlug: string;
    requestId?: string;
    detail?: string;
};
export type BillingClientConfig = {
    appSlug: string;
    apiUrl: string;
    apiKey?: string;
    appSecret?: string;
    cacheTtlMs?: number;
    timeoutMs?: number;
    onError?: (err: Error) => void;
    onFailOpen?: (event: FailOpenEvent) => void;
    fetchImpl?: typeof fetch;
    /** Override for clock — test seam only. */
    now?: () => number;
};
//# sourceMappingURL=types.d.ts.map