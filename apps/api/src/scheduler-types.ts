export interface SchedulerConfig {
  intervalMs?: number;
  /** Runs overdue by more than this are skipped; defaults to five minutes. */
  maxLatenessMs?: number;
  clock?: () => Date;
}

export interface ExecutionContext {
  executedAt: string;
}
