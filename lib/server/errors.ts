import type { RecurringServiceErrorCode } from "../shared/recurring-payment-types";

export class UserAccessError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

export class RecurringPaymentError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: RecurringServiceErrorCode) {
    super(message);
    this.name = "RecurringPaymentError";
  }
}
