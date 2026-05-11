import { describe, expect, it } from "vitest";

import {
  signWebhookPayload,
  verifyWebhookSignature,
} from "./webhook.js";
import type { WebhookEvent } from "./types.js";

const SECRET = "whsec_test_2026";

function makeEvent(): WebhookEvent {
  return {
    id: "evt_123",
    type: "billing.subscription_changed",
    tenantId: "t_1",
    data: {
      tenantId: "t_1",
      planSlug: "homeready-pro",
      status: "ACTIVE",
      monthlyPriceCents: 4900,
      currentPeriodStart: "2026-05-01T00:00:00.000Z",
      currentPeriodEnd: "2026-06-01T00:00:00.000Z",
      trialEndsAt: null,
      limits: {},
    },
  };
}

function signedRequest(
  body: WebhookEvent,
  opts: {
    secret?: string;
    timestampMs?: number;
    tamperBody?: boolean;
    badSignature?: string;
  } = {},
): { headers: Record<string, string>; rawBody: string } {
  const rawBody = JSON.stringify(body);
  const sendBody = opts.tamperBody ? rawBody.replace("ACTIVE", "CHURNED") : rawBody;
  const ts = opts.timestampMs ?? Date.now();
  const sig =
    opts.badSignature ?? signWebhookPayload(opts.secret ?? SECRET, ts, rawBody);
  return {
    headers: {
      "X-Rello-Signature": sig,
      "X-Rello-Timestamp": String(ts),
      "Content-Type": "application/json",
    },
    rawBody: sendBody,
  };
}

describe("verifyWebhookSignature", () => {
  it("returns the parsed event on valid signature", async () => {
    const evt = makeEvent();
    const req = signedRequest(evt);
    const result = await verifyWebhookSignature(req, SECRET);
    expect(result?.type).toBe("billing.subscription_changed");
    expect(result?.id).toBe("evt_123");
  });

  it("returns null when signature is mismatched", async () => {
    const evt = makeEvent();
    const req = signedRequest(evt, { badSignature: "00".repeat(32) });
    expect(await verifyWebhookSignature(req, SECRET)).toBeNull();
  });

  it("returns null when body is tampered after signing", async () => {
    const evt = makeEvent();
    const req = signedRequest(evt, { tamperBody: true });
    expect(await verifyWebhookSignature(req, SECRET)).toBeNull();
  });

  it("returns null when timestamp is older than the replay window", async () => {
    const evt = makeEvent();
    const sixMinAgo = Date.now() - 6 * 60 * 1000;
    const req = signedRequest(evt, { timestampMs: sixMinAgo });
    expect(await verifyWebhookSignature(req, SECRET)).toBeNull();
  });

  it("returns null when timestamp header is missing", async () => {
    const evt = makeEvent();
    const req = signedRequest(evt);
    delete (req.headers as Record<string, string>)["X-Rello-Timestamp"];
    expect(await verifyWebhookSignature(req, SECRET)).toBeNull();
  });

  it("returns null when signature header is missing", async () => {
    const evt = makeEvent();
    const req = signedRequest(evt);
    delete (req.headers as Record<string, string>)["X-Rello-Signature"];
    expect(await verifyWebhookSignature(req, SECRET)).toBeNull();
  });

  it("returns null when signing secret is empty", async () => {
    const evt = makeEvent();
    const req = signedRequest(evt);
    expect(await verifyWebhookSignature(req, "")).toBeNull();
  });

  it("returns null when body is unparseable JSON", async () => {
    const ts = Date.now();
    const raw = "not json";
    const sig = signWebhookPayload(SECRET, ts, raw);
    const req = {
      headers: {
        "X-Rello-Signature": sig,
        "X-Rello-Timestamp": String(ts),
      },
      rawBody: raw,
    };
    expect(await verifyWebhookSignature(req, SECRET)).toBeNull();
  });

  it("accepts a Request object as input", async () => {
    const evt = makeEvent();
    const { headers, rawBody } = signedRequest(evt);
    const request = new Request("https://example/api/webhooks/rello", {
      method: "POST",
      headers,
      body: rawBody,
    });
    const result = await verifyWebhookSignature(request, SECRET);
    expect(result?.id).toBe("evt_123");
  });

  it("accepts Headers via case-insensitive lookup", async () => {
    const evt = makeEvent();
    const ts = Date.now();
    const rawBody = JSON.stringify(evt);
    const sig = signWebhookPayload(SECRET, ts, rawBody);
    // Lowercase header keys
    const req = {
      headers: {
        "x-rello-signature": sig,
        "x-rello-timestamp": String(ts),
      },
      rawBody,
    };
    const result = await verifyWebhookSignature(req, SECRET);
    expect(result?.id).toBe("evt_123");
  });
});
