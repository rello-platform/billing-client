import { createHmac, timingSafeEqual } from "node:crypto";

import type { WebhookEvent } from "./types.js";

/**
 * Replay-protection window for `X-Rello-Timestamp`. Per the binding spec:
 * reject if signed timestamp is older than 5 minutes. Constants are exported
 * so tests can override deterministically.
 */
export const REPLAY_WINDOW_MS = 5 * 60 * 1000;

export const SIGNATURE_HEADER = "x-rello-signature";
export const TIMESTAMP_HEADER = "x-rello-timestamp";

/**
 * Generic header bag accessor — works with both `Headers` (fetch / Next.js
 * Request) and a plain `Record<string, string | string[] | undefined>`
 * (Node http.IncomingMessage style). Returns lowercase-keyed access.
 */
function getHeader(
  headers:
    | Headers
    | Record<string, string | string[] | undefined>
    | undefined
    | null,
  name: string,
): string | null {
  if (!headers) return null;
  const lower = name.toLowerCase();
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(lower);
  }
  const bag = headers as Record<string, string | string[] | undefined>;
  // case-insensitive lookup
  for (const key of Object.keys(bag)) {
    if (key.toLowerCase() === lower) {
      const v = bag[key];
      if (Array.isArray(v)) return v[0] ?? null;
      return v ?? null;
    }
  }
  return null;
}

export type VerifyInput =
  | Request
  | {
      headers:
        | Headers
        | Record<string, string | string[] | undefined>;
      rawBody: string;
    };

export type VerifyOptions = {
  /** Test seam — override clock. */
  now?: () => number;
  /** Test seam — override replay window. */
  replayWindowMs?: number;
};

/**
 * Verify an inbound Rello → spoke billing webhook.
 *
 * Returns the parsed `WebhookEvent` on success, or `null` on:
 *   - missing/invalid signature header
 *   - missing/invalid timestamp header
 *   - timestamp outside the replay window
 *   - signature mismatch (timing-safe compared)
 *   - body parse failure
 *
 * Signature scheme: HMAC-SHA256 over `${timestamp}.${rawBody}` (Stripe-style
 * canonicalization to prevent body / timestamp swap attacks), hex-encoded.
 * Header names per binding spec: `X-Rello-Signature`, `X-Rello-Timestamp`.
 */
export async function verifyWebhookSignature(
  input: VerifyInput,
  signingSecret: string,
  options: VerifyOptions = {},
): Promise<WebhookEvent | null> {
  if (!signingSecret) return null;

  let headers:
    | Headers
    | Record<string, string | string[] | undefined>;
  let rawBody: string;

  if (typeof (input as Request).text === "function") {
    const req = input as Request;
    headers = req.headers;
    try {
      rawBody = await req.text();
    } catch {
      return null;
    }
  } else {
    const obj = input as {
      headers:
        | Headers
        | Record<string, string | string[] | undefined>;
      rawBody: string;
    };
    headers = obj.headers;
    rawBody = obj.rawBody;
  }

  const signature = getHeader(headers, SIGNATURE_HEADER);
  const timestampRaw = getHeader(headers, TIMESTAMP_HEADER);
  if (!signature || !timestampRaw) return null;

  const timestampMs = Number(timestampRaw);
  if (!Number.isFinite(timestampMs)) return null;

  const now = options.now ? options.now() : Date.now();
  const window = options.replayWindowMs ?? REPLAY_WINDOW_MS;
  if (Math.abs(now - timestampMs) > window) return null;

  const expected = createHmac("sha256", signingSecret)
    .update(`${timestampRaw}.${rawBody}`)
    .digest("hex");

  const sigBuf = Buffer.from(signature, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expBuf)) return null;

  try {
    const parsed = JSON.parse(rawBody) as WebhookEvent;
    if (!parsed || typeof parsed !== "object" || !parsed.type || !parsed.id) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Helper for tests + Rello-side dispatcher — produces the canonical signature
 * for a (timestamp, body) pair. Exported so the hub-side dispatcher can sign
 * with the exact same scheme the verifier expects (zero drift risk).
 */
export function signWebhookPayload(
  signingSecret: string,
  timestampMs: number,
  rawBody: string,
): string {
  return createHmac("sha256", signingSecret)
    .update(`${timestampMs}.${rawBody}`)
    .digest("hex");
}
