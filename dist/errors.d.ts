import type { BillingErrorCode } from "./types.js";
export declare class BillingError extends Error {
    readonly code: BillingErrorCode;
    readonly status: number;
    readonly requestId: string | undefined;
    constructor(code: BillingErrorCode, status: number, message: string, requestId?: string);
}
export declare function codeForStatus(status: number): BillingErrorCode;
//# sourceMappingURL=errors.d.ts.map