import { getCurrentUser } from "@/lib/current-user";
import { recurringPaymentHandlers } from "@/lib/recurring-payment-handlers";
import { listRecurringPayments, mutateRecurringPayment, runRecurringPayments } from "@/lib/recurring-payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export const GET = recurringPaymentHandlers({
  currentUser: getCurrentUser, list: listRecurringPayments, mutate: mutateRecurringPayment,
  run: runRecurringPayments, environment: () => process.env,
}).cron;
