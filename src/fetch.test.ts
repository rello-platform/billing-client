import { describe, expect, it } from "vitest";

import { authToken, executeWithRetries, normalizeApiUrl } from "./fetch.js";
import type { BillingClientConfig } from "./types.js";

function cfg(over: Partial<BillingClientConfig> = {}): BillingClientConfig {
  return {
    appSlug: "homeready",
    apiUrl: "https://hellorello.app",
    apiKey: "rello_test_key",
    timeoutMs: 100,
    ...over,
  };
}

describe("normalizeApiUrl", () => {
  it("strips trailing slash", () => {
    expect(normalizeApiUrl("https://hellorello.app/")).toBe(
      "https://hellorello.app",
    );
  });

  it("strips trailing /api", () => {
    expect(normalizeApiUrl("https://hellorello.app/api")).toBe(
      "https://hellorello.app",
    );
  });

  it("strips trailing /api/ (both /)", () => {
    expect(normalizeApiUrl("https://hellorello.app/api/")).toBe(
      "https://hellorello.app",
    );
  });

  it("leaves plain root untouched", () => {
    expect(normalizeApiUrl("https://hellorello.app")).toBe(
      "https://hellorello.app",
    );
  });

  it("trims whitespace", () => {
    expect(normalizeApiUrl("  https://hellorello.app/  ")).toBe(
      "https://hellorello.app",
    );
  });
});

describe("authToken precedence", () => {
  it("prefers apiKey over appSecret", () => {
    expect(
      authToken(
        cfg({ apiKey: "rello_db_key", appSecret: "shared_secret" }),
      ),
    ).toBe("rello_db_key");
  });

  it("uses appSecret when no apiKey", () => {
    expect(
      authToken(cfg({ apiKey: undefined, appSecret: "shared_secret" })),
    ).toBe("shared_secret");
  });

  it("throws synchronously when neither provided", () => {
    expect(() =>
      authToken(cfg({ apiKey: undefined, appSecret: undefined })),
    ).toThrow(/apiKey or appSecret/);
  });
});

describe("executeWithRetries", () => {
  it("does NOT retry on 4xx (write op)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("bad input", { status: 400 });
    }) as typeof fetch;

    const result = await executeWithRetries(
      "https://hellorello.app",
      cfg({ fetchImpl }),
      {
        method: "POST",
        path: "/billing/checkout",
        tenantId: "t_1",
        body: { planSlug: "homeready-pro" },
        attempts: 2,
      },
    );

    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(400);
      expect(result.error.code).toBe("BILLING_INVALID_REQUEST");
    }
  });

  it("retries on 5xx up to the configured attempts (writes = 2)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("upstream", { status: 503 });
    }) as typeof fetch;

    const result = await executeWithRetries(
      "https://hellorello.app",
      cfg({ fetchImpl }),
      {
        method: "POST",
        path: "/billing/checkout",
        tenantId: "t_1",
        attempts: 2,
      },
    );

    expect(calls).toBe(2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("BILLING_UPSTREAM_5XX");
    }
  });

  it("retries on 5xx up to 3 attempts for reads", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("upstream", { status: 502 });
    }) as typeof fetch;

    const result = await executeWithRetries(
      "https://hellorello.app",
      cfg({ fetchImpl }),
      {
        method: "GET",
        path: "/billing/status",
        tenantId: "t_1",
        attempts: 3,
      },
    );

    expect(calls).toBe(3);
    expect(result.ok).toBe(false);
  });

  it("treats network errors as retryable + reports BILLING_NETWORK_ERROR after exhaustion", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      throw new Error("ECONNRESET");
    }) as typeof fetch;

    const result = await executeWithRetries(
      "https://hellorello.app",
      cfg({ fetchImpl }),
      {
        method: "GET",
        path: "/billing/status",
        tenantId: "t_1",
        attempts: 3,
      },
    );

    expect(calls).toBe(3);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("BILLING_NETWORK_ERROR");
    }
  });

  it("succeeds after a transient 5xx (retry semantics)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls < 2) return new Response("upstream", { status: 503 });
      return new Response(JSON.stringify({ ok: true, value: 42 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await executeWithRetries<{ ok: true; value: number }>(
      "https://hellorello.app",
      cfg({ fetchImpl }),
      {
        method: "GET",
        path: "/billing/status",
        tenantId: "t_1",
        attempts: 3,
      },
    );

    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.value).toBe(42);
  });

  it("sends required auth headers + X-Request-Id", async () => {
    let captured: Record<string, string> | undefined;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const h = init?.headers as Record<string, string>;
      captured = h;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await executeWithRetries(
      "https://hellorello.app",
      cfg({ fetchImpl, apiKey: "rello_xyz" }),
      {
        method: "GET",
        path: "/billing/status",
        tenantId: "t_42",
        attempts: 1,
      },
    );

    expect(captured?.["Authorization"]).toBe("Bearer rello_xyz");
    expect(captured?.["X-Tenant-Id"]).toBe("t_42");
    expect(captured?.["X-App-Slug"]).toBe("homeready");
    expect(captured?.["X-Request-Id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(captured?.["Content-Type"]).toBe("application/json");
  });

  it("sends Idempotency-Key when provided", async () => {
    let captured: Record<string, string> | undefined;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      captured = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await executeWithRetries(
      "https://hellorello.app",
      cfg({ fetchImpl }),
      {
        method: "POST",
        path: "/billing/usage",
        tenantId: "t_1",
        body: { metric: "emails_sent", quantity: 1 },
        idempotencyKey: "send_42:email_sent",
        attempts: 2,
      },
    );

    expect(captured?.["Idempotency-Key"]).toBe("send_42:email_sent");
  });
});
