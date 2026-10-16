import type { ExecutionStore } from "@4evergent/database";

export interface RecoveryOptions {
  /** Override clock for deterministic testing. */
  now?: () => Date;
}

export interface RecoveryResult {
  /** Number of stuck executions found. */
  found: number;
  /** Number of executions successfully recovered (moved to "failed"). */
  recovered: number;
  /** IDs of executions that were recovered (for audit/debug). */
  recoveredIds: string[];
  /** Number of executions skipped (e.g., txHash present — ambiguous submission). */
  skipped: number;
  /** Errors encountered during recovery (record-level, non-fatal). */
  errors: Array<{ id: string; error: string }>;
}

/**
 * ExecutionRecoveryService — scans persisted ExecutionStore for records stuck in
 * "executing" state (e.g., process crashed mid-execution) and moves them to
 * "failed" with an immediate `nextRetryAt` so the existing ExecutionQueue worker
 * can pick them up for retry.
 *
 * SEMANTICS:
 *   - Does NOT create duplicate records.
 *   - Does NOT reset retry count (preserves existing `attempt`).
 *   - Does NOT execute transactions directly — only changes persisted state.
 *   - Records already in a terminal state (submitted, confirmed, failed,
 *     dead_letter, cancelled) or queued are NOT touched.
 *   - Idempotent: calling recover() multiple times on the same store is safe;
 *     once a record is moved out of "executing", it is no longer eligible.
 *
 * CRASH LIMITATION:
 *   Recovery can only address the LOCAL persisted state. If a transaction was
 *   actually submitted to the network before the crash but the local record was
 *   still in "executing", the transaction may have executed on-chain even though
 *   local state shows "failed" after recovery.  This is a fundamental
 *   network-vs-local ambiguity and is NOT exactly-once safe without an
 *   external confirmation/idempotency mechanism (documented as a limitation).
 */
export class ExecutionRecoveryService {
  private now: () => Date;

  constructor(
    private store: ExecutionStore,
    private options: RecoveryOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Scan ExecutionStore for "executing" records and transition each to
   * "failed" with `nextRetryAt` set to the current time (immediately eligible).
   *
   * Retry count (`attempt`) and `errorClass` are preserved.  If the execution
   * had already reached the configured max retries, the queue worker will move
   * it to `dead_letter` on the next attempt.
   */
  async recover(): Promise<RecoveryResult> {
    const result: RecoveryResult = {
      found: 0,
      recovered: 0,
      recoveredIds: [],
      skipped: 0,
      errors: [],
    };

    try {
      const stuck = await this.store.listStuckExecuting();
      result.found = stuck.length;
      const now = this.now();

      for (const record of stuck) {
        try {
          // Idempotency guard: re-fetch current state.  If the record is no
          // longer "executing" (e.g., claimed by a concurrent worker), skip.
          const current = await this.store.get(record.id);
          if (!current || current.status !== "executing") continue;

          // CONSERVATIVE RECOVERY:
          // If txHash is present, the transaction may have been submitted to the
          // network before crash. Do NOT blindly move to failed/retry — leave it
          // for reconciliation to determine actual on-chain status.
          // Only executions WITHOUT txHash are safe to recover immediately.
          if (current.txHash) {
            // Leave as executing; reconciliation will handle it
            result.skipped++;
            continue;
          }

          await this.store.update(record.id, {
            status: "failed",
            nextRetryAt: now.toISOString(),
            startedAt: null,
            updatedAt: now.toISOString(),
            // Preserve existing attempt/errorClass/retry metadata.
          });
          result.recovered++;
          result.recoveredIds.push(record.id);
        } catch (err) {
          result.errors.push({
            id: record.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      // If the scan itself fails, record as a top-level error.
      result.errors.push({
        id: "<scan>",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return result;
  }
}
