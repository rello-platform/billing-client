/**
 * @rello-platform/billing-client
 *
 * Canonical typed HTTP client + webhook verifier for the Rello v1 billing
 * API. Every spoke app imports from here — no app rolls its own billing
 * fetch wrapper.
 *
 * Binding contract: see CROSS-APP-BILLING-V2.md §Spoke-Side Contract.
 *
 * Rule E (PLATFORM-CLASS-LEVEL-RULES): consumers MUST import the response
 * types from this package's `types` re-exports — never redeclare locally.
 */
export { createBillingClient } from "./client.js";
export { verifyWebhookSignature, signWebhookPayload } from "./webhook.js";
export { BillingError } from "./errors.js";
//# sourceMappingURL=index.js.map