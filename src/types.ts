/**
 * Canonical response types for the Rello v1 billing API.
 *
 * Rule E (PLATFORM-CLASS-LEVEL-RULES): consumers (Rello API routes, spoke
 * apps, hooks) MUST import these types from here — never redeclare locally.
 * Drift between this contract and a redeclared `interface` becomes a silent
 * NaN/undefined at runtime, not a compile error.
 */

export type BillingSubscriptionStatus =
  | "ACTIVE"
  | "TRIAL"
  | "PAST_DUE"
  | "CHURNED"
  | "SUSPENDED";

/**
 * The `billing.subscription_changed` WEBHOOK payload (Rello builds it in
 * src/lib/billing/build-billing-status.ts). This is NOT what
 * GET /api/v1/billing/status returns — that is {@link BillingStatusData}.
 */
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

/**
 * GET /api/v1/billing/status → `data`. Mirrors the object Rello builds at
 * src/app/api/v1/billing/status/route.ts:156-169 (Rello main d9102280).
 * Rello declares no interface for it, so the field types come from the route
 * body and the Prisma schema. Dates arrive as ISO strings (JSON).
 */
export type BillingStatusData = {
  tenant: BillingStatusTenant;
  /** Latest Stripe subscription for the tenant's customer; null when none / Stripe off / Stripe error. */
  subscription: BillingStatusSubscription | null;
  /** The tenant's ACTIVE add-ons. */
  addOns: BillingStatusAddOn[];
  /** Current calendar-month usage per metric. */
  usage: BillingStatusUsage[];
  /** Plan quotas; null = no finite quota for that metric. */
  limits: BillingQuotas;
};

/** Prisma `TenantStatus`. */
export type TenantStatus =
  | "TRIAL"
  | "ACTIVE"
  | "PAST_DUE"
  | "SUSPENDED"
  | "CHURNED"
  | "DELETED";

export type BillingStatusTenant = {
  id: string;
  name: string;
  status: TenantStatus;
  /** `Tenant.plan` — a plan slug such as "growth"; null when unset. */
  plan: string | null;
};

/** Stripe `Subscription.status`, passed through verbatim. */
export type StripeSubscriptionStatus =
  | "active"
  | "canceled"
  | "incomplete"
  | "incomplete_expired"
  | "past_due"
  | "paused"
  | "trialing"
  | "unpaid";

export type BillingStatusSubscription = {
  id: string;
  status: StripeSubscriptionStatus;
  planName: string | null;
  planId: string | null;
  /**
   * null when Stripe omits `current_period_*` on the subscription (newer Stripe
   * API versions moved it to the items): Rello builds `new Date(NaN)`, which
   * JSON-serializes as null.
   */
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

export type BillingStatusAddOn = {
  id: string;
  name: string;
  appSlug: string;
  /** Prisma `SubscriptionStatus`; Rello only returns ACTIVE rows here. */
  status: "ACTIVE" | "PAST_DUE" | "CANCELED" | "INCOMPLETE" | "TRIALING";
  quantity: number;
  activatedAt: string;
};

export type BillingStatusUsage = {
  metric: string;
  currentPeriodTotal: number;
  limit: number | null;
  percentUsed: number | null;
};

/** Rello's `QuotasView` (src/lib/billing/plan-limits-types.ts). */
export type BillingQuotas = {
  users: number | null;
  contacts: number | null;
  emails: number | null;
  sms: number | null;
  journeys: number | null;
  aiDecisions: number | null;
};

/**
 * The `billing.entitlement_changed` WEBHOOK payload. GET /api/v1/entitlements
 * returns {@link EntitlementsCollection}, not an array of these.
 */
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

/** POST /api/v1/billing/usage → `data` (src/app/api/v1/billing/usage/route.ts:543-546). */
export type UsageReportResult = {
  recorded: true;
  usageRecordId: string;
  /** Present only when the emit was vendor-tagged and a CostLedger row was written. */
  costLedgerId?: string;
};

/**
 * GET /api/v1/entitlements — a FLAT body (no envelope). Mirrors Rello's
 * `EntitlementsCollectionResponse` (src/app/api/v1/entitlements/route.ts).
 */
export type EntitlementsCollection = {
  tenantId: string;
  /** Keyed by canonical app slug. */
  entitlements: Record<string, EntitlementsCollectionEntry>;
};

/** Mirrors Rello's `EntitlementsCollectionEntry`. */
export type EntitlementsCollectionEntry = {
  tier: string;
  isTrialing: boolean;
  isExpired: boolean;
  expiresAt: string | null;
  trialEndsAt: string | null;
  limits: Record<string, number | null> | null;
  currentUsage: Record<string, number> | null;
};

/**
 * Options every mutating method accepts. The client sends `X-Idempotency-Key`
 * on every mutation: generated once per logical call (a random UUID) and
 * reused across that call's retries. Pass `idempotencyKey` to choose the key
 * yourself — e.g. a key persisted with your own row, so a retry of the whole
 * operation (not just one HTTP attempt) replays instead of repeating it.
 * Rello accepts 8–128 characters after trimming; outside that the client
 * throws before sending anything.
 */
export type MutationOptions = {
  idempotencyKey?: string;
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

/**
 * POST /api/v1/billing/checkout, plan flow. Rello reads `planId` (a Plan row
 * id, not a slug) and an optional `billingCycle` (checkout/route.ts:147-160);
 * the client adds the body `idempotencyKey` Rello requires.
 */
export type CheckoutSessionRequest = {
  planId: string;
  successUrl: string;
  cancelUrl: string;
  billingCycle?: "MONTHLY" | "ANNUAL";
};

/** POST /api/v1/billing/checkout → `data`. `url` is Stripe's `Session.url`, which Stripe types nullable. */
export type CheckoutSessionResponse = {
  sessionId: string;
  url: string | null;
};

export type PortalSessionRequest = {
  returnUrl: string;
};

/** POST /api/v1/billing/portal → `data` (Rello `BillingPortalResponse`). */
export type PortalSessionResponse = {
  url: string;
};

export type AddOnRequest = {
  addOnId: string;
  quantity?: number;
};

/** POST /api/v1/billing/add-on → `data` (Rello `BillingAddOnAddResponse`). */
export type AddOnResponse = {
  tenantAddOnId: string;
  status: string;
};

/** DELETE /api/v1/billing/add-on/:addOnId → `data` (Rello `BillingAddOnRemoveResponse`). */
export type RemoveAddOnResponse = {
  ok: true;
};

export type SubscriptionCancelRequest = {
  atPeriodEnd: boolean;
};

/** POST /api/v1/billing/subscription/cancel → `data` (Rello `BillingSubscriptionCancelResponse`). */
export type SubscriptionCancelResponse = {
  cancelsAt: string | null;
  status: string;
};

/** POST /api/v1/billing/subscription/resume → `data` (Rello `BillingSubscriptionResumeResponse`). */
export type SubscriptionResumeResponse = {
  status: string;
  periodEnd: string | null;
};

export type SubscriptionUpdateRequest = {
  planSlug: string;
  billingCycle?: "MONTHLY" | "ANNUAL";
};

/** PUT /api/v1/billing/subscription → `data` (Rello `BillingSubscriptionUpdateResponse`). */
export type SubscriptionUpdateResponse = {
  status: string;
  periodEnd: string | null;
  proration: {
    /** Unix seconds. */
    prorationDate: number;
    /** Stripe's previewed amount due; null when the preview failed. */
    amountCents: number | null;
  };
};

export type WebhookEventType =
  | "billing.subscription_changed"
  | "billing.addon_changed"
  | "billing.invoice_paid"
  | "billing.invoice_failed"
  | "billing.trial_ending"
  | "billing.entitlement_changed";

export type WebhookEvent =
  | {
      id: string;
      type: "billing.subscription_changed";
      tenantId: string;
      data: BillingStatus;
    }
  | {
      id: string;
      type: "billing.addon_changed";
      tenantId: string;
      data: { addOnId: string; status: "ADDED" | "REMOVED" };
    }
  | {
      id: string;
      type: "billing.invoice_paid";
      tenantId: string;
      data: { invoiceId: string; amountCents: number };
    }
  | {
      id: string;
      type: "billing.invoice_failed";
      tenantId: string;
      data: { invoiceId: string; reason: string };
    }
  | {
      id: string;
      type: "billing.trial_ending";
      tenantId: string;
      data: { trialEndsAt: string };
    }
  | {
      id: string;
      type: "billing.entitlement_changed";
      tenantId: string;
      data: Entitlement;
    };

export type BillingErrorCode =
  | "BILLING_UNAUTHORIZED"
  | "BILLING_NOT_FOUND"
  | "BILLING_CONFLICT"
  | "BILLING_RATE_LIMITED"
  | "BILLING_UPSTREAM_5XX"
  | "BILLING_NETWORK_ERROR"
  | "BILLING_INVALID_REQUEST"
  /** A 2xx whose body is not Rello's contract: no envelope, success:false, or missing data. */
  | "BILLING_INVALID_RESPONSE";

export type FailOpenReason =
  | "network"
  | "timeout"
  | "upstream_5xx"
  | "unauthorized"
  | "invalid_response";

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
