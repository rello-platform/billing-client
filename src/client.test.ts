import { describe, expect, it, vi } from "vitest";

import { createBillingClient } from "./client.js";
import { BillingError } from "./errors.js";
import type { BillingClientConfig, BillingStatus } from "./types.js";

function makeFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init ?? {});
  }) as unknown as typeof fetch;
}

function cfg(over: Partial<BillingClientConfig> = {}): BillingClientConfig {
  return {
    appSlug: "homeready",
    apiUrl: "https://hellorello.app/api",
    apiKey: "rello_test",
    timeoutMs: 100,
    ...over,
  };
}

const SAMPLE_STATUS: BillingStatus = {
  tenantId: "t_1",
  planSlug: "homeready-pro",
  status: "ACTIVE",
  monthlyPriceCents: 4900,
  currentPeriodStart: "2026-05-01T00:00:00.000Z",
  currentPeriodEnd: "2026-06-01T00:00:00.000Z",
  trialEndsAt: null,
  limits: { leads: 500 },
};

describe("createBillingClient — construction", () => {
  it("throws synchronously when neither apiKey nor appSecret is provided", () => {
    expect(() =>
      createBillingClient({
        appSlug: "homeready",
        apiUrl: "https://hellorello.app",
      }),
    ).toThrow(/apiKey or appSecret/);
  });

  it("constructs with apiKey only", () => {
    expect(() =>
      createBillingClient({
        appSlug: "homeready",
        apiUrl: "https://hellorello.app",
        apiKey: "rello_xyz",
      }),
    ).not.toThrow();
  });

  it("constructs with appSecret only and warns once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createBillingClient({
      appSlug: "homeready",
      apiUrl: "https://hellorello.app",
      appSecret: "shared",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Using RELLO_APP_SECRET fallback"),
    );
    warn.mockRestore();
  });
});

describe("getStatus — fail-open reads", () => {
  it("returns response data on success", async () => {
    const client = createBillingClient(
      cfg({
        fetchImpl: makeFetch(() =>
          new Response(JSON.stringify(SAMPLE_STATUS), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      }),
    );
    const status = await client.getStatus("t_1");
    expect(status.planSlug).toBe("homeready-pro");
  });

  it("returns cached value on subsequent call within TTL", async () => {
    let calls = 0;
    const client = createBillingClient(
      cfg({
        fetchImpl: makeFetch(() => {
          calls++;
          return new Response(JSON.stringify(SAMPLE_STATUS), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }),
      }),
    );
    await client.getStatus("t_1");
    await client.getStatus("t_1");
    expect(calls).toBe(1);
  });

  it("returns permissive default on 5xx with no cached value", async () => {
    const onFailOpen = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = createBillingClient(
      cfg({
        fetchImpl: makeFetch(() => new Response("err", { status: 503 })),
        onFailOpen,
      }),
    );
    const status = await client.getStatus("t_1");
    expect(status.planSlug).toBe("fail-open-permissive");
    expect(status.status).toBe("ACTIVE");
    expect(onFailOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "billing_fail_open",
        operation: "getStatus",
        tenantId: "t_1",
        appSlug: "homeready",
        reason: "upstream_5xx",
      }),
    );
    warn.mockRestore();
  });

  it("returns last cached (stale) value on 5xx if cache populated", async () => {
    let phase: "ok" | "fail" = "ok";
    const client = createBillingClient(
      cfg({
        cacheTtlMs: 1,
        fetchImpl: makeFetch(() => {
          if (phase === "ok") {
            return new Response(JSON.stringify(SAMPLE_STATUS), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response("err", { status: 503 });
        }),
      }),
    );
    await client.getStatus("t_1");
    await new Promise((r) => setTimeout(r, 5));
    phase = "fail";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const status = await client.getStatus("t_1");
    expect(status.planSlug).toBe("homeready-pro");
    warn.mockRestore();
  });
});

describe("checkAccess — fail-open default true", () => {
  it("returns true on 5xx", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = createBillingClient(
      cfg({
        fetchImpl: makeFetch(() => new Response("err", { status: 503 })),
      }),
    );
    const allowed = await client.checkAccess("t_1", "homeready");
    expect(allowed).toBe(true);
    warn.mockRestore();
  });

  it("returns server's allowed=false when API reports it", async () => {
    const client = createBillingClient(
      cfg({
        fetchImpl: makeFetch(() =>
          new Response(JSON.stringify({ allowed: false }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      }),
    );
    const allowed = await client.checkAccess("t_1", "premium");
    expect(allowed).toBe(false);
  });
});

describe("writes — fail-closed", () => {
  it("throws BillingError on 5xx (after retries)", async () => {
    const client = createBillingClient(
      cfg({
        fetchImpl: makeFetch(() => new Response("err", { status: 503 })),
      }),
    );
    await expect(
      client.createCheckoutSession("t_1", {
        planSlug: "homeready-pro",
        successUrl: "https://x/s",
        cancelUrl: "https://x/c",
      }),
    ).rejects.toBeInstanceOf(BillingError);
  });

  it("throws BillingError on 400 immediately (no retry on 4xx)", async () => {
    let calls = 0;
    const client = createBillingClient(
      cfg({
        fetchImpl: makeFetch(() => {
          calls++;
          return new Response("invalid plan", { status: 400 });
        }),
      }),
    );
    await expect(
      client.addAddOn("t_1", { addOnId: "arive" }),
    ).rejects.toBeInstanceOf(BillingError);
    expect(calls).toBe(1);
  });

  it("reportUsage throws when idempotencyKey is missing", async () => {
    const client = createBillingClient(
      cfg({ fetchImpl: makeFetch(() => new Response("{}", { status: 200 })) }),
    );
    await expect(
      client.reportUsage("t_1", {
        metric: "emails_sent",
        quantity: 1,
        // intentionally missing
        idempotencyKey: "",
      }),
    ).rejects.toThrow(/idempotencyKey/);
  });

  it("createCheckoutSession returns parsed response on success", async () => {
    const client = createBillingClient(
      cfg({
        fetchImpl: makeFetch(() =>
          new Response(
            JSON.stringify({ url: "https://checkout/x", sessionId: "cs_1" }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      }),
    );
    const r = await client.createCheckoutSession("t_1", {
      planSlug: "homeready-pro",
      successUrl: "https://x/s",
      cancelUrl: "https://x/c",
    });
    expect(r.sessionId).toBe("cs_1");
  });
});

describe("URL normalization at construction time", () => {
  it("strips trailing /api so calls go to /api/v1/billing/...", async () => {
    const urls: string[] = [];
    const client = createBillingClient(
      cfg({
        apiUrl: "https://hellorello.app/api",
        fetchImpl: makeFetch((url) => {
          urls.push(url);
          return new Response(JSON.stringify(SAMPLE_STATUS), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }),
      }),
    );
    await client.getStatus("t_1");
    expect(urls[0]).toBe("https://hellorello.app/api/v1/billing/status");
  });
});
