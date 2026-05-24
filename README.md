# `@rello-platform/billing-client`

Canonical typed HTTP client + webhook verifier for the Rello v1 billing API. Every spoke app on the Rello platform imports from this package — no app rolls its own billing fetch wrapper.

**Binding contract:** see `~/Library/Mobile Documents/com~apple~CloudDocs/ClearPath Utah Mortgage/Applications/~Application Docs/RELLO TO BE BUILT/BUILD-|-WORKSTREAM/CROSS APP BILLING V2/CROSS-APP-BILLING-V2.md` §Spoke-Side Contract.

## Install

```bash
npm install @rello-platform/billing-client
```

Requires a `.npmrc` with the Rello GitHub Packages registry alias:

```
@rello-platform:registry=https://npm.pkg.github.com
```

## Quickstart

```ts
import { createBillingClient } from "@rello-platform/billing-client";

const billing = createBillingClient({
  appSlug: "homeready",
  apiUrl: process.env.RELLO_API_URL!,
  apiKey: process.env.RELLO_API_KEY,        // preferred: DB-managed key (rello_...)
  appSecret: process.env.RELLO_APP_SECRET,  // fallback: shared secret
});

// Reads — cached 60s, fail-open
const status = await billing.getStatus(tenantId);
const allowed = await billing.checkAccess(tenantId, "homeready");

// Revenue-only per-app spend summary (powers the in-app billing panel).
// Defaults to the current calendar month; pass { year, month } for another.
const summary = await billing.getUsageSummary(tenantId);
const lastMonth = await billing.getUsageSummary(tenantId, { year: 2026, month: 4 });

// Writes — fail-closed (throws BillingError on any error)
await billing.reportUsage(tenantId, {
  metric: "emails_sent",
  quantity: 1,
  idempotencyKey: `${sendId}:email_sent`,
});
const session = await billing.createCheckoutSession(tenantId, {
  planSlug: "homeready-pro",
  successUrl: "https://...",
  cancelUrl: "https://...",
});
```

## Webhook verification

```ts
import { verifyWebhookSignature } from "@rello-platform/billing-client/webhook";

export async function POST(request: Request) {
  const event = await verifyWebhookSignature(
    request,
    process.env.RELLO_WEBHOOK_SIGNING_SECRET!,
  );
  if (!event) return new Response("invalid signature", { status: 401 });

  switch (event.type) {
    case "billing.subscription_changed":
      await upsertBillingSubscription(event.tenantId, event.data);
      break;
    case "billing.addon_changed":
      // ...
      break;
  }
  return Response.json({ ok: true });
}
```

Signature scheme: HMAC-SHA256 over `${timestamp}.${rawBody}`, hex-encoded. Headers: `X-Rello-Signature`, `X-Rello-Timestamp`. Replay window: 5 minutes.

## Auth strategy

The client accepts either a DB-managed API key (`rello_<64 hex>`) or a shared platform secret. **`apiKey` is preferred** — DB keys are individually revocable, rotatable, and scoped via `ApiKey.permissions`. Falls back to `appSecret` only for apps that haven't been provisioned a DB key yet; emits a one-time warning when it does.

If neither is provided, `createBillingClient` throws synchronously.

## Failure semantics — reads fail open, writes fail closed

| Operation | Failure mode |
|-----------|-------------|
| `getStatus` | Returns last cached value, else permissive default. Structured log emitted. |
| `getEntitlements` | Returns last cached, else "allow all" placeholder. |
| `getUsageSummary` | Returns last cached, else a safe-empty summary ($0, no rows/allotments, portal unavailable) — the panel always renders. Structured log emitted. |
| `checkAccess` | Returns `true` (permissive). |
| `reportUsage` | **Throws** `BillingError`. Caller is responsible for DLQ (each spoke app maintains a `UsageReportDLQ` table per spec). |
| `createCheckoutSession`, `createPortalSession`, `addAddOn`, `removeAddOn`, `cancelSubscription`, `resumeSubscription`, `updateSubscription` | **Throw** `BillingError`. |

Every fail-open event emits a structured log line: `event=billing_fail_open reason=<cause> operation=<op> tenantId=<id> appSlug=<slug>`.

## Retry policy

- **Reads:** 3 attempts, 250ms / 500ms / 1s backoff. Retries on 5xx + network/timeout only.
- **Writes:** 2 attempts. Retries on 5xx only. **Never** retries on 4xx.

Every write sends an `Idempotency-Key` header when one is provided, so Rello deduplicates even on caller-side retries.

## URL normalization

`apiUrl` is normalized once at construction: trailing `/` stripped, trailing `/api` stripped. Paths are joined as `/api/v1/billing/...` at call time. Kills the double-`/api` bug class permanently.

## Cache

In-memory TTL cache, 60s default, keyed by `(tenantId, operation)`. Per-process, not shared across instances. Cleared on every write (entitlements may have changed).

## Stack

- Node `>=22 <23`
- TypeScript 5, ESM only
- Zero runtime deps (uses Node's built-in `node:crypto` + global `fetch`)

## Build + publish

```bash
npm install
npm run build       # tsc → dist/
npm test            # vitest
```

`dist/` is committed to the repo (per platform convention for `@rello-platform/*` packages — Railway nixpacks has no ssh client and consumers install via git ref).

Publishing happens automatically on tagged push (`git tag v0.1.0 && git push --tags`) via `.github/workflows/publish.yml`.
