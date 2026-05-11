import { createHmac, timingSafeEqual } from "node:crypto";
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
function getHeader(headers, name) {
    if (!headers)
        return null;
    const lower = name.toLowerCase();
    if (typeof headers.get === "function") {
        return headers.get(lower);
    }
    const bag = headers;
    // case-insensitive lookup
    for (const key of Object.keys(bag)) {
        if (key.toLowerCase() === lower) {
            const v = bag[key];
            if (Array.isArray(v))
                return v[0] ?? null;
            return v ?? null;
        }
    }
    return null;
}
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
export async function verifyWebhookSignature(input, signingSecret, options = {}) {
    if (!signingSecret)
        return null;
    let headers;
    let rawBody;
    if (typeof input.text === "function") {
        const req = input;
        headers = req.headers;
        try {
            rawBody = await req.text();
        }
        catch {
            return null;
        }
    }
    else {
        const obj = input;
        headers = obj.headers;
        rawBody = obj.rawBody;
    }
    const signature = getHeader(headers, SIGNATURE_HEADER);
    const timestampRaw = getHeader(headers, TIMESTAMP_HEADER);
    if (!signature || !timestampRaw)
        return null;
    const timestampMs = Number(timestampRaw);
    if (!Number.isFinite(timestampMs))
        return null;
    const now = options.now ? options.now() : Date.now();
    const window = options.replayWindowMs ?? REPLAY_WINDOW_MS;
    if (Math.abs(now - timestampMs) > window)
        return null;
    const expected = createHmac("sha256", signingSecret)
        .update(`${timestampRaw}.${rawBody}`)
        .digest("hex");
    const sigBuf = Buffer.from(signature, "hex");
    const expBuf = Buffer.from(expected, "hex");
    if (sigBuf.length !== expBuf.length)
        return null;
    if (!timingSafeEqual(sigBuf, expBuf))
        return null;
    try {
        const parsed = JSON.parse(rawBody);
        if (!parsed || typeof parsed !== "object" || !parsed.type || !parsed.id) {
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
}
/**
 * Helper for tests + Rello-side dispatcher — produces the canonical signature
 * for a (timestamp, body) pair. Exported so the hub-side dispatcher can sign
 * with the exact same scheme the verifier expects (zero drift risk).
 */
export function signWebhookPayload(signingSecret, timestampMs, rawBody) {
    return createHmac("sha256", signingSecret)
        .update(`${timestampMs}.${rawBody}`)
        .digest("hex");
}
//# sourceMappingURL=webhook.js.map