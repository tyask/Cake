import { getCurrentUser } from "@/lib/server/auth/current-user";
import { recurringPaymentHandlers } from "@/lib/server/handlers/recurring-payment-handlers";
import { createRecurringPaymentService } from "@/lib/server/services/recurring-payments";
import { recurringPaymentStore } from "@/lib/server/stores/recurring-payment-store";

const { listRecurringPayments, mutateRecurringPayment, runRecurringPayments } = createRecurringPaymentService(recurringPaymentStore);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export const POST = recurringPaymentHandlers({
  currentUser: getCurrentUser, list: listRecurringPayments, mutate: mutateRecurringPayment,
  run: runRecurringPayments, environment: () => process.env,
}).manualRun;
