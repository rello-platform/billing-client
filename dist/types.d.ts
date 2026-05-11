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