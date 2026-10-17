import type { ActivityStore } from "@4evergent/database";
import type { AuthModule } from "./auth.js";

export interface DataRetentionOptions {
  store: Pick<ActivityStore, "sweepDailySpending">;
  authModule?: Pick<AuthModule, "sweepExpiredSessions"> | null;
  now?: number;
  authSessionDays?: number;
  dailySpendingDays?: number;
  batchSize?: number;
}

export interface DataRetentionResult {
  authSessionsRemoved: number;
  dailySpendingRemoved: number;
}

/** One bounded sweep. A zero-day window disables cleanup for that table. */
export async function sweepRetainedData(options: DataRetentionOptions): Promise<DataRetentionResult> {
  const now = options.now ?? Date.now();
  const sessionDays = Number.isFinite(options.authSessionDays) && (options.authSessionDays ?? -1) >= 0
    ? options.authSessionDays!
    : 30;
  const spendingDays = Number.isFinite(options.dailySpendingDays) && (options.dailySpendingDays ?? -1) >= 0
    ? options.dailySpendingDays!
    : 90;
  const batchSize = Number.isInteger(options.batchSize) && (options.batchSize ?? 0) > 0
    ? options.batchSize!
    : 500;
  const sessionCutoff = now - sessionDays * 24 * 60 * 60_000;
  const spendingCutoffDate = new Date(now);
  spendingCutoffDate.setUTCDate(spendingCutoffDate.getUTCDate() - spendingDays);
  const spendingCutoff = spendingCutoffDate.toISOString().slice(0, 10);

  const authSessionsRemoved = sessionDays > 0
    ? options.authModule?.sweepExpiredSessions(sessionCutoff, batchSize) ?? 0
    : 0;
  const dailySpendingRemoved = spendingDays > 0
    ? await options.store.sweepDailySpending(spendingCutoff, batchSize)
    : 0;

  return { authSessionsRemoved, dailySpendingRemoved };
}
