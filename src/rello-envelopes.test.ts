/**
 * D-105 — every method returns Rello's data, typed to Rello's actual shape,
 * and every mutation sends X-Idempotency-Key.
 *
 * The fixtures below are Rello's REAL response bodies, transcribed from the
 * route handlers at Rello main d91022801a5b9a3869e7a478798d11894f66ba24:
 *
 *   GET    /api/v1/billing/status             status/route.ts:156-169        { success, data }
 *   GET    /api/v1/entitlements               entitlements/route.ts:107-111  flat
 *   GET    /api/v1/billing/usage/summary      usage/summary/route.ts:254-266 { success, data }
 *   GET    /api/v1/entitlements/check         entitlements/check/route.ts:76-84 flat
 *   POST   /api/v1/billing/usage              usage/route.ts:543-546         { success, data }
 *   POST   /api/v1/billing/checkout           checkout/route.ts:238-244      { success, data }
 *   POST   /api/v1/billing/portal             portal/route.ts:99             { success, data }
 *   POST   /api/v1/billing/add-on             add-on/route.ts:202            { success, data }
 *   DELETE /api/v1/billing/add-on/:addOnId    add-on/[addOnId]/route.ts:138  { success, data }
 *   POST   /api/v1/billing/subscription/cancel   cancel/route.ts:157         { success, data }
 *   POST   /api/v1/billing/subscription/resume   resume/route.ts:125         { success, data }
 *   PUT    /api/v1/billing/subscription          subscription/route.ts:215   { success, data }
 *
 * The fake server also enforces Rello's idempotency gates exactly as Rello
 * does: `readIdempotencyKey` (src/lib/billing/v1/idempotency-header.ts:11-36,
 * 400 IDEMPOTENCY_KEY_REQUIRED / IDEMPOTENCY_KEY_INVALID, 8–128 chars after
 * trim) on portal / add-on / remove add-on / cancel / resume / update, and the
 * BODY `idempotencyKey` (8–128) on plan checkout (checkout/route.ts:153-176).
 *
 * This file is type-checked by `tsc -p tsconfig.test.json` (run by
 * `npm test`), so the `satisfies` clauses fail the build when the package's
 * types drift from these bodies.
 */
import { describe, expect, it, vi } from "vitest";

import { createBillingClient } from "./client.js";
import { BillingError } from "./errors.js";
import type {
  AddOnResponse,
  BillingClientConfig,
  BillingStatusData,
  BillingUsageSummary,
  CheckoutSessionResponse,
  EntitlementsCollection,
  PortalSessionResponse,
  RemoveAddOnResponse,
  SubscriptionCancelResponse,
  SubscriptionResumeResponse,
  SubscriptionUpdateResponse,
  UsageReportResult,
} from "./types.js";

// ── Rello's real `data` payloads ──────────────────────────────────────────

const STATUS_DATA = {
  tenant: { id: "t_1", name: "Big Star Realty", status: "ACTIVE", plan: "growth" },
  subscription: {
    id: "sub_123",
    status: "active",
    planName: "Growth",
    planId: "price_123",
    currentPeriodStart: "2026-10-01T00:00:00.000Z",
    currentPeriodEnd: "2026-11-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
  },
  addOns: [
    {
      id: "addon_arive",
      name: "Arive LOS",
      appSlug: "homeready",
      status: "ACTIVE",
      quantity: 1,
      activatedAt: "2026-09-01T12:00:00.000Z",
    },
  ],
  usage: [{ metric: "emails", currentPeriodTotal: 120, limit: 1000, percentUsed: 12 }],
  limits: {
    users: 5,
    contacts: 2500,
    emails: 1000,
    sms: null,
    journeys: null,
    aiDecisions: 200,
  },
} satisfies BillingStatusData;

/** Stripe's newer API versions drop `current_period_*`; Rello then serializes Invalid Date → null. */
const STATUS_DATA_NO_SUB_PERIOD = {
  ...STATUS_DATA,
  subscription: { ...STATUS_DATA.subscription, currentPeriodStart: null, currentPeriodEnd: null },
} satisfies BillingStatusData;

const ENTITLEMENTS_BODY = {
  tenantId: "t_1",
  entitlements: {
    homeready: {
      tier: "pro",
      isTrialing: false,
      isExpired: false,
      expiresAt: null,
      trialEndsAt: null,
      limits: { "quota.contacts": 2500, "quota.sms": null },
      currentUsage: { "quota.contacts": 10 },
    },
  },
} satisfies EntitlementsCollection;

const SUMMARY_DATA = {
  appSlug: "homeready",
  appName: "HomeReady",
  period: {
    year: 2026,
    month: 10,
    label: "October 2026",
    start: "2026-10-01T00:00:00.000Z",
    end: "2026-10-31T23:59:59.999Z",
  },
  totalRevenueCents: 1200,
  totalRevenueKnown: true,
  recordCount: 3,
  rows: [
    {
      appSlug: "homeready",
      appName: "HomeReady",
      metric: "enrichments",
      metricName: "Enrichments",
      unit: "lookup",
      service: null,
      quantity: 3,
      revenueCents: 1200,
      revenueKnown: true,
    },
  ],
  allotments: [],
  portalAvailable: true,
} satisfies BillingUsageSummary;

const USAGE_DATA = { recorded: true, usageRecordId: "ur_1" } satisfies UsageReportResult;
const USAGE_DATA_WITH_LEDGER = {
  recorded: true,
  usageRecordId: "ur_2",
  costLedgerId: "cl_2",
} satisfies UsageReportResult;
const CHECKOUT_DATA = {
  sessionId: "cs_test_1",
  url: "https://checkout.stripe.com/c/pay/cs_test_1",
} satisfies CheckoutSessionResponse;
const PORTAL_DATA = { url: "https://billing.stripe.com/p/session/x" } satisfies PortalSessionResponse;
const ADD_ON_DATA = { tenantAddOnId: "ta_1", status: "ACTIVE" } satisfies AddOnResponse;
const REMOVE_DATA = { ok: true } satisfies RemoveAddOnResponse;
const CANCEL_DATA = {
  cancelsAt: "2026-11-01T00:00:00.000Z",
  status: "ACTIVE",
} satisfies SubscriptionCancelResponse;
const RESUME_DATA = { status: "active", periodEnd: null } satisfies SubscriptionResumeResponse;
const UPDATE_DATA = {
  status: "active",
  periodEnd: "2026-11-01T00:00:00.000Z",
  proration: { prorationDate: 1790000000, amountCents: null },
} satisfies SubscriptionUpdateResponse;

// ── A fake Rello that behaves like Rello ─────────────────────────────────

type Seen = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
};

type RouteKey = string; // "METHOD /path-without-query"

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Rello's readIdempotencyKey (idempotency-header.ts:11-36), verbatim semantics. */
function relloIdempotencyGate(headers: Record<string, string>): Response | null {
  const key = headers["X-Idempotency-Key"]?.trim() ?? "";
  if (!key) {
    return json(400, {
      success: false,
      error: "X-Idempotency-Key header is required",
      code: "IDEMPOTENCY_KEY_REQUIRED",
    });
  }
  if (key.length < 8 || key.length > 128) {
    return json(400, {
      success: false,
      error: "X-Idempotency-Key must be 8–128 characters",
      code: "IDEMPOTENCY_KEY_INVALID",
    });
  }
  return null;
}

const HEADER_GATED = new Set<RouteKey>([
  "POST /billing/portal",
  "POST /billing/add-on",
  "DELETE /billing/add-on/addon_arive",
  "POST /billing/subscription/cancel",
  "POST /billing/subscription/resume",
  "PUT /billing/subscription",
]);

const REAL_BODIES: Record<RouteKey, unknown> = {
  "GET /billing/status": { success: true, data: STATUS_DATA },
  "GET /entitlements": ENTITLEMENTS_BODY,
  "GET /billing/usage/summary": { success: true, data: SUMMARY_DATA },
  "GET /entitlements/check": {
    allowed: true,
    tier: "pro",
    isTrialing: false,
    isExpired: false,
    limits: null,
    currentUsage: null,
  },
  "POST /billing/usage": { success: true, data: USAGE_DATA },
  "POST /billing/checkout": { success: true, data: CHECKOUT_DATA },
  "POST /billing/portal": { success: true, data: PORTAL_DATA },
  "POST /billing/add-on": { success: true, data: ADD_ON_DATA },
  "DELETE /billing/add-on/addon_arive": { success: true, data: REMOVE_DATA },
  "POST /billing/subscription/cancel": { success: true, data: CANCEL_DATA },
  "POST /billing/subscription/resume": { success: true, data: RESUME_DATA },
  "PUT /billing/subscription": { success: true, data: UPDATE_DATA },
};

function fakeRello(opts: {
  bodies?: Record<RouteKey, unknown>;
  /** Respond 503 to the first N requests (exercises the retry path). */
  fail5xxFirst?: number;
} = {}) {
  const seen: Seen[] = [];
  const bodies = { ...REAL_BODIES, ...(opts.bodies ?? {}) };
  let failures = opts.fail5xxFirst ?? 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ method, path, headers, body });
    const key = `${method} ${path}`;

    if (HEADER_GATED.has(key)) {
      const refusal = relloIdempotencyGate(headers);
      if (refusal) return refusal;
    }
    if (key === "POST /billing/checkout") {
      const k =
        typeof (body as { idempotencyKey?: unknown })?.idempotencyKey === "string"
          ? (body as { idempotencyKey: string }).idempotencyKey.trim()
          : "";
      if (!k || k.length < 8 || k.length > 128) {
        return json(400, {
          success: false,
          error: "idempotencyKey is required (8-128 characters)",
          code: "VALIDATION_ERROR",
        });
      }
    }
    if (failures > 0) {
      failures -= 1;
      return json(503, { success: false, error: "Billing service not configured" });
    }
    if (!(key in bodies)) return json(404, { error: `no fixture for ${key}` });
    return json(200, bodies[key]);
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

function cfg(fetchImpl: typeof fetch, over: Partial<BillingClientConfig> = {}): BillingClientConfig {
  return {
    appSlug: "homeready",
    apiUrl: "https://hellorello.app",
    apiKey: "rello_test",
    timeoutMs: 100,
    fetchImpl,
    ...over,
  };
}

// ── Every method, every call shape ───────────────────────────────────────

type Call = {
  name: string;
  route: RouteKey;
  mutating: boolean;
  /** Invoke with an optional caller-supplied idempotency key. */
  run: (c: ReturnType<typeof createBillingClient>, key?: string) => Promise<unknown>;
  expected: unknown;
};

const CALLS: Call[] = [
  {
    name: "getStatus",
    route: "GET /billing/status",
    mutating: false,
    run: (c) => c.getStatus("t_1"),
    expected: STATUS_DATA,
  },
  {
    name: "getEntitlements",
    route: "GET /entitlements",
    mutating: false,
    run: (c) => c.getEntitlements("t_1"),
    expected: ENTITLEMENTS_BODY,
  },
  {
    name: "getUsageSummary",
    route: "GET /billing/usage/summary",
    mutating: false,
    run: (c) => c.getUsageSummary("t_1"),
    expected: SUMMARY_DATA,
  },
  {
    name: "checkAccess",
    route: "GET /entitlements/check",
    mutating: false,
    run: (c) => c.checkAccess("t_1", "homeready"),
    expected: true,
  },
  {
    name: "reportUsage",
    route: "POST /billing/usage",
    mutating: true,
    run: (c) =>
      c.reportUsage("t_1", { metric: "enrichments", quantity: 1, idempotencyKey: "lead_1:enrichments" }),
    expected: USAGE_DATA,
  },
  {
    name: "createCheckoutSession",
    route: "POST /billing/checkout",
    mutating: true,
    run: (c, key) =>
      c.createCheckoutSession(
        "t_1",
        { planId: "plan_growth", successUrl: "https://a.example/ok", cancelUrl: "https://a.example/no" },
        key ? { idempotencyKey: key } : undefined,
      ),
    expected: CHECKOUT_DATA,
  },
  {
    name: "createPortalSession",
    route: "POST /billing/portal",
    mutating: true,
    run: (c, key) =>
      c.createPortalSession(
        "t_1",
        { returnUrl: "https://a.example/settings" },
        key ? { idempotencyKey: key } : undefined,
      ),
    expected: PORTAL_DATA,
  },
  {
    name: "addAddOn",
    route: "POST /billing/add-on",
    mutating: true,
    run: (c, key) =>
      c.addAddOn("t_1", { addOnId: "addon_arive" }, key ? { idempotencyKey: key } : undefined),
    expected: ADD_ON_DATA,
  },
  {
    name: "removeAddOn",
    route: "DELETE /billing/add-on/addon_arive",
    mutating: true,
    run: (c, key) => c.removeAddOn("t_1", "addon_arive", key ? { idempotencyKey: key } : undefined),
    expected: REMOVE_DATA,
  },
  {
    name: "cancelSubscription",
    route: "POST /billing/subscription/cancel",
    mutating: true,
    run: (c, key) =>
      c.cancelSubscription("t_1", { atPeriodEnd: true }, key ? { idempotencyKey: key } : undefined),
    expected: CANCEL_DATA,
  },
  {
    name: "resumeSubscription",
    route: "POST /billing/subscription/resume",
    mutating: true,
    run: (c, key) => c.resumeSubscription("t_1", key ? { idempotencyKey: key } : undefined),
    expected: RESUME_DATA,
  },
  {
    name: "updateSubscription",
    route: "PUT /billing/subscription",
    mutating: true,
    run: (c, key) =>
      c.updateSubscription("t_1", { planSlug: "growth" }, key ? { idempotencyKey: key } : undefined),
    expected: UPDATE_DATA,
  },
];

/** Mutations whose idempotency key the caller chooses through `opts` (reportUsage uses usage.idempotencyKey). */
const KEYED_MUTATIONS = CALLS.filter((c) => c.mutating && c.name !== "reportUsage");

describe("D-105: every method returns Rello's data (real envelopes, Rello main d9102280)", () => {
  for (const call of CALLS) {
    it(`${call.name} returns Rello's data, not the envelope`, async () => {
      const rello = fakeRello();
      const client = createBillingClient(cfg(rello.fetchImpl));
      const got = await call.run(client);
      expect(got).toEqual(call.expected);
    });
  }

  it("getStatus returns subscription periods as null when Rello serializes them null", async () => {
    const rello = fakeRello({
      bodies: { "GET /billing/status": { success: true, data: STATUS_DATA_NO_SUB_PERIOD } },
    });
    const client = createBillingClient(cfg(rello.fetchImpl));
    const got = await client.getStatus("t_1");
    expect(got.subscription?.currentPeriodEnd).toBeNull();
  });

  it("reportUsage returns costLedgerId when Rello wrote one", async () => {
    const rello = fakeRello({
      bodies: { "POST /billing/usage": { success: true, data: USAGE_DATA_WITH_LEDGER } },
    });
    const client = createBillingClient(cfg(rello.fetchImpl));
    await expect(
      client.reportUsage("t_1", { metric: "ai_tokens", quantity: 5, idempotencyKey: "doc_1:ai_tokens" }),
    ).resolves.toEqual(USAGE_DATA_WITH_LEDGER);
  });
});

describe("D-105: a missing or success:false body throws an error naming the call", () => {
  const ENVELOPED = CALLS.filter((c) => !["getEntitlements", "checkAccess"].includes(c.name));

  for (const call of ENVELOPED) {
    it(`${call.name}: 200 { success: false } throws naming ${call.name}`, async () => {
      const rello = fakeRello({
        bodies: { [call.route]: { success: false, error: "upstream said no" } },
      });
      const client = createBillingClient(cfg(rello.fetchImpl));
      const err = await call.run(client).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(BillingError);
      expect((err as BillingError).code).toBe("BILLING_INVALID_RESPONSE");
      expect((err as BillingError).message).toContain(call.name);
      expect((err as BillingError).message).toContain("upstream said no");
    });

    it(`${call.name}: 200 { success: true } with no data throws naming ${call.name}`, async () => {
      const rello = fakeRello({ bodies: { [call.route]: { success: true } } });
      const client = createBillingClient(cfg(rello.fetchImpl));
      await expect(call.run(client)).rejects.toThrow(new RegExp(`^${call.name}:`));
    });

    it(`${call.name}: a bare (un-enveloped) payload throws naming ${call.name}`, async () => {
      const rello = fakeRello({ bodies: { [call.route]: call.expected } });
      const client = createBillingClient(cfg(rello.fetchImpl));
      await expect(call.run(client)).rejects.toThrow(new RegExp(`^${call.name}:`));
    });
  }

  it("getEntitlements: a body without `entitlements` throws naming getEntitlements", async () => {
    const rello = fakeRello({ bodies: { "GET /entitlements": { tenantId: "t_1" } } });
    const client = createBillingClient(cfg(rello.fetchImpl));
    await expect(client.getEntitlements("t_1")).rejects.toThrow(/^getEntitlements:/);
  });

  it("checkAccess: a 200 without a boolean `allowed` throws naming checkAccess (never a default)", async () => {
    const rello = fakeRello({ bodies: { "GET /entitlements/check": { success: true } } });
    const client = createBillingClient(cfg(rello.fetchImpl));
    await expect(client.checkAccess("t_1", "homeready")).rejects.toThrow(/^checkAccess:/);
  });

  it("a mutation Rello 2xx'd still clears the read caches when its body is invalid", async () => {
    let statusReads = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/billing/status")) {
        statusReads += 1;
        return json(200, { success: true, data: STATUS_DATA });
      }
      return json(200, { success: true }); // add-on: 2xx, no data
    }) as unknown as typeof fetch;
    const client = createBillingClient(cfg(fetchImpl));
    await client.getStatus("t_1");
    await expect(client.addAddOn("t_1", { addOnId: "addon_arive" })).rejects.toThrow(/^addAddOn:/);
    await client.getStatus("t_1");
    expect(statusReads).toBe(2);
  });

  it("an invalid body is never cached: the next call re-reads Rello", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      return n === 1 ? json(200, { success: true }) : json(200, { success: true, data: STATUS_DATA });
    }) as unknown as typeof fetch;
    const client = createBillingClient(cfg(fetchImpl));
    await expect(client.getStatus("t_1")).rejects.toThrow(/^getStatus:/);
    await expect(client.getStatus("t_1")).resolves.toEqual(STATUS_DATA);
  });
});

describe("D-105: mutations send X-Idempotency-Key", () => {
  for (const call of CALLS.filter((c) => c.mutating)) {
    it(`${call.name} sends an X-Idempotency-Key Rello accepts (8–128 chars)`, async () => {
      const rello = fakeRello();
      const client = createBillingClient(cfg(rello.fetchImpl));
      await call.run(client);
      const key = rello.seen[0]?.headers["X-Idempotency-Key"];
      expect(typeof key).toBe("string");
      expect((key ?? "").length).toBeGreaterThanOrEqual(8);
      expect((key ?? "").length).toBeLessThanOrEqual(128);
    });

    it(`${call.name} reuses ONE key across the retries of one call`, async () => {
      const rello = fakeRello({ fail5xxFirst: 1 });
      const client = createBillingClient(cfg(rello.fetchImpl));
      await expect(call.run(client)).resolves.toEqual(call.expected);
      expect(rello.seen).toHaveLength(2);
      const [first, second] = rello.seen;
      expect(first?.headers["X-Idempotency-Key"]).toBeTruthy();
      expect(second?.headers["X-Idempotency-Key"]).toBe(first?.headers["X-Idempotency-Key"]);
    });
  }

  for (const call of KEYED_MUTATIONS) {
    it(`${call.name}: two logical calls get two different keys`, async () => {
      const rello = fakeRello();
      const client = createBillingClient(cfg(rello.fetchImpl));
      await call.run(client);
      await call.run(client);
      const [a, b] = rello.seen.map((s) => s.headers["X-Idempotency-Key"]);
      expect(a).toBeTruthy();
      expect(b).toBeTruthy();
      expect(a).not.toBe(b);
    });

    it(`${call.name}: a caller-supplied key overrides the generated one (and survives the retry)`, async () => {
      const rello = fakeRello({ fail5xxFirst: 1 });
      const client = createBillingClient(cfg(rello.fetchImpl));
      await call.run(client, "caller-key-0001");
      expect(rello.seen.map((s) => s.headers["X-Idempotency-Key"])).toEqual([
        "caller-key-0001",
        "caller-key-0001",
      ]);
    });

    it(`${call.name}: a caller key Rello would refuse throws before any request`, async () => {
      const rello = fakeRello();
      const client = createBillingClient(cfg(rello.fetchImpl));
      await expect(call.run(client, "short")).rejects.toThrow(new RegExp(`^${call.name}:.*8–128`));
      await expect(call.run(client, "x".repeat(129))).rejects.toThrow(new RegExp(`^${call.name}:`));
      expect(rello.seen).toHaveLength(0);
    });
  }

  it("reportUsage sends usage.idempotencyKey as X-Idempotency-Key, unchanged", async () => {
    const rello = fakeRello({ fail5xxFirst: 1 });
    const client = createBillingClient(cfg(rello.fetchImpl));
    await client.reportUsage("t_1", { metric: "enrichments", quantity: 1, idempotencyKey: "lead_1:enrichments" });
    expect(rello.seen.map((s) => s.headers["X-Idempotency-Key"])).toEqual([
      "lead_1:enrichments",
      "lead_1:enrichments",
    ]);
    expect((rello.seen[0]?.body as { idempotencyKey?: string }).idempotencyKey).toBe("lead_1:enrichments");
  });

  it("createCheckoutSession also carries the key in the body, where Rello reads it", async () => {
    const rello = fakeRello();
    const client = createBillingClient(cfg(rello.fetchImpl));
    await client.createCheckoutSession(
      "t_1",
      { planId: "plan_growth", successUrl: "https://a.example/ok", cancelUrl: "https://a.example/no" },
      { idempotencyKey: "checkout-key-01" },
    );
    expect(rello.seen[0]?.body).toEqual({
      planId: "plan_growth",
      successUrl: "https://a.example/ok",
      cancelUrl: "https://a.example/no",
      idempotencyKey: "checkout-key-01",
    });
    expect(rello.seen[0]?.headers["X-Idempotency-Key"]).toBe("checkout-key-01");
  });

  it("reads never send X-Idempotency-Key", async () => {
    const rello = fakeRello();
    const client = createBillingClient(cfg(rello.fetchImpl));
    await client.getStatus("t_1");
    await client.getEntitlements("t_1");
    await client.getUsageSummary("t_1");
    await client.checkAccess("t_1", "homeready");
    for (const s of rello.seen) expect(s.headers["X-Idempotency-Key"]).toBeUndefined();
  });
});

describe("getStatus fail-open on 5xx / network: unchanged from v0.3.0", () => {
  it("5xx with nothing cached → the permissive status (Rello's shape), logged as fail-open", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = (async () => json(503, { success: false })) as unknown as typeof fetch;
    const client = createBillingClient(cfg(fetchImpl));
    const got = await client.getStatus("t_1");
    expect(got).toEqual({
      tenant: { id: "t_1", name: "", status: "ACTIVE", plan: "fail-open-permissive" },
      subscription: null,
      addOns: [],
      usage: [],
      limits: { users: null, contacts: null, emails: null, sms: null, journeys: null, aiDecisions: null },
    } satisfies BillingStatusData);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("event=billing_fail_open reason=upstream_5xx"));
    warn.mockRestore();
  });

  it("a 4xx also still fails open (v0.3.0 behaviour, deliberately not changed here)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = (async () => json(401, { success: false, error: "Unauthorized" })) as unknown as typeof fetch;
    const client = createBillingClient(cfg(fetchImpl));
    const got = await client.getStatus("t_1");
    expect(got.tenant.plan).toBe("fail-open-permissive");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("reason=unauthorized"));
    warn.mockRestore();
  });

  it("network error after a good read → the stale cached data", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let t = 0;
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      if (n === 1) return json(200, { success: true, data: STATUS_DATA });
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const client = createBillingClient(cfg(fetchImpl, { cacheTtlMs: 10, now: () => t }));
    await client.getStatus("t_1");
    t = 1_000;
    await expect(client.getStatus("t_1")).resolves.toEqual(STATUS_DATA);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("reason=network"));
    warn.mockRestore();
  });
});

// ── Phase 50 (D-121): A-249 undecodable 2xx bodies, A-250 flat success:false ──

/** A fetch that answers every request with the same raw 200 body; counts requests per path. */
function rawFetch(body: string, contentType: string) {
  const paths: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    paths.push(new URL(String(input)).pathname.replace(/^\/api\/v1/, ""));
    return new Response(body, { status: 200, headers: { "content-type": contentType } });
  }) as unknown as typeof fetch;
  return { fetchImpl, paths };
}

const UNDECODABLE_200: Array<{ label: string; body: string; contentType: string; says: RegExp }> = [
  { label: "empty 200", body: "", contentType: "application/json", says: /with an empty body/ },
  { label: "HTML 200", body: "<html>broken</html>", contentType: "text/html", says: /not JSON \(text\/html\)/ },
];

describe("A-249: a 2xx whose body is empty or not JSON is a contract error naming the method", () => {
  for (const shape of UNDECODABLE_200) {
    for (const call of CALLS) {
      it(`${call.name}: ${shape.label} → BILLING_INVALID_RESPONSE naming ${call.name}, one request, no fail-open`, async () => {
        const onError = vi.fn();
        const onFailOpen = vi.fn();
        const raw = rawFetch(shape.body, shape.contentType);
        const client = createBillingClient(cfg(raw.fetchImpl, { onError, onFailOpen }));
        const err = await call.run(client).then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(BillingError);
        expect((err as BillingError).code).toBe("BILLING_INVALID_RESPONSE");
        expect((err as BillingError).status).toBe(200);
        expect((err as BillingError).message).toMatch(new RegExp(`^${call.name}: `));
        expect((err as BillingError).message).toMatch(shape.says); // says what was wrong with the body
        expect(raw.paths).toHaveLength(1); // a decoded-or-not 2xx is never retried
        expect(onFailOpen).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "BILLING_INVALID_RESPONSE" }));
      });
    }
  }

  it("cached-read control: an expired cached status does not mask an empty 200 (throws, no stale)", async () => {
    let t = 0;
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      return n === 1
        ? json(200, { success: true, data: STATUS_DATA })
        : new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const client = createBillingClient(cfg(fetchImpl, { cacheTtlMs: 10, now: () => t }));
    await expect(client.getStatus("t_1")).resolves.toEqual(STATUS_DATA);
    t = 1_000;
    await expect(client.getStatus("t_1")).rejects.toThrow(/^getStatus: /);
    expect(n).toBe(2);
  });

  const CACHE_CLEARING = ["addAddOn", "removeAddOn", "cancelSubscription", "resumeSubscription", "updateSubscription"];
  for (const shape of UNDECODABLE_200) {
    for (const name of CACHE_CLEARING) {
      const call = CALLS.find((c) => c.name === name)!;
      it(`${name}: a 2xx with an ${shape.label} body still invalidates the cached status`, async () => {
        let statusReads = 0;
        const fetchImpl = (async (input: string | URL | Request) => {
          const path = new URL(String(input)).pathname;
          if (path.endsWith("/billing/status")) {
            statusReads += 1;
            return json(200, { success: true, data: STATUS_DATA });
          }
          return new Response(shape.body, { status: 200, headers: { "content-type": shape.contentType } });
        }) as unknown as typeof fetch;
        const client = createBillingClient(cfg(fetchImpl));
        await client.getStatus("t_1");
        await expect(call.run(client)).rejects.toThrow(new RegExp(`^${name}: `));
        await client.getStatus("t_1");
        expect(statusReads).toBe(2);
      });
    }
  }

  it("control: HTTP 204 and JSON null stay method-named contract errors", async () => {
    for (const res of [() => new Response(null, { status: 204 }), () => json(200, null)]) {
      const fetchImpl = (async () => res()) as unknown as typeof fetch;
      const client = createBillingClient(cfg(fetchImpl));
      await expect(client.createPortalSession("t_1", { returnUrl: "https://a.example" })).rejects.toThrow(
        /^createPortalSession: /,
      );
    }
  });

  it("control: a real network failure is still BILLING_NETWORK_ERROR and still fails open for reads (D-119)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const client = createBillingClient(cfg(fetchImpl));
    await expect(client.getStatus("t_1")).resolves.toMatchObject({ tenant: { plan: "fail-open-permissive" } });
    expect(n).toBe(3);
    await expect(client.createPortalSession("t_1", { returnUrl: "https://a.example" })).rejects.toMatchObject({
      code: "BILLING_NETWORK_ERROR",
    });
    warn.mockRestore();
  });
});

describe("A-250: a flat body carrying success:false is rejected before its payload is accepted", () => {
  it('checkAccess: {"success":false,"error":"explicit denial","allowed":true} throws naming checkAccess, not cached', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      return json(200, { success: false, error: "explicit denial", allowed: true });
    }) as unknown as typeof fetch;
    const onError = vi.fn();
    const client = createBillingClient(cfg(fetchImpl, { onError }));
    await expect(client.checkAccess("t_1", "homeready")).rejects.toThrow(/^checkAccess: .*explicit denial/);
    await expect(client.checkAccess("t_1", "homeready")).rejects.toThrow(/^checkAccess: /);
    expect(n).toBe(2);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "BILLING_INVALID_RESPONSE" }));
  });

  it('getEntitlements: {"success":false,…,"tenantId":"t1","entitlements":{}} throws naming getEntitlements, not cached', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      return json(200, { success: false, error: "explicit denial", tenantId: "t1", entitlements: {} });
    }) as unknown as typeof fetch;
    const client = createBillingClient(cfg(fetchImpl));
    await expect(client.getEntitlements("t_1")).rejects.toThrow(/^getEntitlements: .*explicit denial/);
    await expect(client.getEntitlements("t_1")).rejects.toThrow(/^getEntitlements: /);
    expect(n).toBe(2);
  });

  it("control: a legitimate {allowed:false} is still a deny, cached", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      return json(200, { allowed: false });
    }) as unknown as typeof fetch;
    const client = createBillingClient(cfg(fetchImpl));
    await expect(client.checkAccess("t_1", "homeready")).resolves.toBe(false);
    await expect(client.checkAccess("t_1", "homeready")).resolves.toBe(false);
    expect(n).toBe(1);
  });

  it("control: Rello's catch-path {allowed:false} and a flat collection without `success` stay valid", async () => {
    const rello = fakeRello({
      bodies: { "GET /entitlements/check": { allowed: false } },
    });
    const client = createBillingClient(cfg(rello.fetchImpl));
    await expect(client.checkAccess("t_1", "homeready")).resolves.toBe(false);
    await expect(client.getEntitlements("t_1")).resolves.toEqual(ENTITLEMENTS_BODY);
  });
});
