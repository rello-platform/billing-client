import type { BillingErrorCode } from "./types.js";

export class BillingError extends Error {
  public readonly code: BillingErrorCode;
  public readonly status: number;
  public readonly requestId: string | undefined;

  constructor(
    code: BillingErrorCode,
    status: number,
    message: string,
    requestId?: string,
  ) {
    super(message);
    this.name = "BillingError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

export function codeForStatus(status: number): BillingErrorCode {
  if (status === 401 || status === 403) return "BILLING_UNAUTHORIZED";
  if (status === 404) return "BILLING_NOT_FOUND";
  if (status === 409) return "BILLING_CONFLICT";
  if (status === 429) return "BILLING_RATE_LIMITED";
  if (status >= 500) return "BILLING_UPSTREAM_5XX";
  return "BILLING_INVALID_REQUEST";
}
