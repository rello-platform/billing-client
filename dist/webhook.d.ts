import type { WebhookEvent } from "./types.js";
/**
 * Replay-protection window for `X-Rello-Timestamp`. Per the binding spec:
 * reject if signed timestamp is older than 5 minutes. Constants are exported
 * so tests can override deterministically.
 */
export declare const REPLAY_WINDOW_MS: number;
export declare const SIGNATURE_HEADER = "x-rello-signature";
export declare const TIMESTAMP_HEADER = "x-rello-timestamp";
export type VerifyInput = Request | {
    headers: Headers | Record<string, string | string[] | undefined>;
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
export declare function verifyWebhookSignature(input: VerifyInput, signingSecret: string, options?: VerifyOptions): Promise<WebhookEvent | null>;
/**
 * Helper for tests + Rello-side dispatcher — produces the canonical signature
 * for a (timestamp, body) pair. Exported so the hub-side dispatcher can sign
 * with the exact same scheme the verifier expects (zero drift risk).
 */
export declare function signWebhookPayload(signingSecret: string, timestampMs: number, rawBody: string): string;
//# sourceMappingURL=webhook.d.ts.map