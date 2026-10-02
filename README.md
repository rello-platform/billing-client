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

// Reads — cached 60s, fail-open on an outage
const status = await billing.getStatus(tenantId); // { tenant, subscription, addOns, usage, limits }
if (status.tenant.status === "SUSPENDED") { /* ... */ }
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
  planId,                      // a Rello Plan row id
  successUrl: "https://...",
  cancelUrl: "https://...",
});
const { url } = await billing.createPortalSession(tenantId, { returnUrl });
```

## What every method returns

Rello wraps most v1 billing responses as `{ success: true, data }`. Every
method returns **`data`**, typed to the shape Rello's route builds (the two
flat routes, `/entitlements` and `/entitlements/check`, return their whole
body). A 2xx whose body is not that contract — empty or not JSON, no envelope,
`success: false` (on a flat route too), missing or malformed `data` — throws
`BillingError` with code
`BILLING_INVALID_RESPONSE` and a message that starts with the method name.
An unreadable body never becomes a default.

| Method | Returns |
|---|---|
| `getStatus` | `BillingStatusData` — `{ tenant: { id, name, status, plan }, subscription \| null, addOns, usage, limits }` |
| `getEntitlements` | `EntitlementsCollection` — `{ tenantId, entitlements: Record<appSlug, …> }` |
| `getUsageSummary` | `BillingUsageSummary` |
| `checkAccess` | `boolean` (`allowed`) |
| `reportUsage` | `UsageReportResult` — `{ recorded: true, usageRecordId, costLedgerId? }` |
| `createCheckoutSession` | `{ sessionId, url: string \| null }` |
| `createPortalSession` | `{ url }` |
| `addAddOn` | `{ tenantAddOnId, status }` |
| `removeAddOn` | `{ ok: true }` |
| `cancelSubscription` | `{ cancelsAt, status }` |
| `resumeSubscription` | `{ status, periodEnd: string \| null }` |
| `updateSubscription` | `{ status, periodEnd: string \| null, proration: { prorationDate, amountCents } }` |

`BillingStatus` and `Entitlement` remain exported: they are the **webhook**
payload types (`billing.subscription_changed`, `billing.entitlement_changed`),
not what the read methods return.

## Idempotency

Every mutation sends `X-Idempotency-Key` — Rello's v1 billing mutations 400
without it. The key is generated once per logical call (a CSPRNG UUID) and
reused across that call's retries, so a retried request replays Rello's cached
result instead of acting twice. Pass your own as the last argument when the
operation must stay idempotent across *your* retries too (8–128 characters;
anything else throws before a request is sent):

```ts
await billing.addAddOn(tenantId, { addOnId }, { idempotencyKey: purchase.id });
```

`reportUsage` uses `usage.idempotencyKey` (required) as both the body key and
the header. `createCheckoutSession` also puts the key in the body, where
Rello's checkout route reads it.

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
| `getStatus` | Non-2xx or network/timeout: last cached value, else the permissive status (`tenant.plan: "fail-open-permissive"`, `ACTIVE`, no quotas). Structured log emitted. |
| `getEntitlements` | Non-2xx or network/timeout: last cached, else `{ tenantId, entitlements: {} }`. |
| `getUsageSummary` | Non-2xx or network/timeout: last cached, else a safe-empty summary ($0, no rows/allotments, portal unavailable) — the panel renders through an outage. Structured log emitted. |
| `checkAccess` | Non-2xx or network/timeout: `true` (permissive), logged with `console.error`. |
| Any read | A **2xx with an invalid body throws** (`BILLING_INVALID_RESPONSE`) — including an empty or non-JSON body. It is a contract break, not an outage: never retried, never failed open. |
| `reportUsage` | **Throws** `BillingError`. Caller is responsible for DLQ (each spoke app maintains a `UsageReportDLQ` table per spec). |
| `createCheckoutSession`, `createPortalSession`, `addAddOn`, `removeAddOn`, `cancelSubscription`, `resumeSubscription`, `updateSubscription` | **Throw** `BillingError`. |

Every fail-open event emits a structured log line: `event=billing_fail_open reason=<cause> operation=<op> tenantId=<id> appSlug=<slug>`.

## Retry policy

- **Reads:** 3 attempts, 250ms / 500ms / 1s backoff. Retries on 5xx + network/timeout only.
- **Writes:** 2 attempts. Retries on 5xx only. **Never** retries on 4xx.

Every write sends `X-Idempotency-Key`, the same value on each attempt (see Idempotency).

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
npm run compile       # tsc → dist/
npm test            # vitest
```

`dist/` is committed to the repo (per platform convention for `@rello-platform/*` packages — Railway nixpacks has no ssh client and consumers install via git ref).

Publishing happens automatically on tagged push (`git tag v0.1.0 && git push --tags`) via `.github/workflows/publish.yml`.

## Local verification (pre-push hook)

CI (`ci.yml`) was retired 2026-05-24 (GH-Actions retirement workstream). Verification
now runs locally via a committed husky-style `.husky/pre-push` hook — the same
`tsc --noEmit && npm run compile && npm test` the workflow ran.

The hook is **not** auto-installed (no `prepare`/`postinstall` script — this is a
git-dep package and a lifecycle script would run in every consumer's install). Enable
it once per clone:

```sh
git config core.hooksPath .husky
```
