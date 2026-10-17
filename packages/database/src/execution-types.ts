import type { AgentIntent, PolicyDecision, SimulationResult } from "@4evergent/shared";

/**
 * ExecutionStatus — lifecycle of a queued execution.
 *
 *   queued   → execution scheduled (approval given or schedule due)
 *   executing → in-flight, pipeline running
 *   submitted → pipeline returned txHash
 *   confirmed → on-chain confirmation observed (future; requires indexing)
 *   failed    → pipeline returned an error (eligible for retry if transient)
 *   dead_letter → exhausted retries / permanent failure
 */
export type ExecutionStatus =
  | "queued"
  | "executing"
  | "submitted"
  | "confirmed"
  | "failed"
  | "dead_letter";

export interface ExecutionRecord {
  id: string;
  /** owner-scoped identifier */
  ownerId: string;
  /** agent-scoped identifier */
  agentId: string;
  /** links to the originating approval (for approval-driven execution) */
  approvalId: string | null;
  /** links to the originating activity (for schedule-driven execution) */
  activityId: string | null;
  /** the typed intent to execute */
  intent: AgentIntent;
  /** current execution status */
  status: ExecutionStatus;
  /** pipeline output if available */
  policyDecision: PolicyDecision | null;
  simulationResult: SimulationResult | null;
  txHash: string | null;
  /** hash of the signed transaction submitted to Horizon, used for pre-check before retry */
  submittedHash: string | null;
  error: string | null;
  /** number of attempts so far (incremented on each enqueue for retry) */
  attempt: number;
  /** next retry timestamp (ISO), set when a retry is scheduled */
  nextRetryAt: string | null;
  /** timestamp when this execution last entered "executing" */
  startedAt: string | null;
  /** timestamp when this execution reached a terminal state */
  completedAt: string | null;
  /** classification that determined retry eligibility */
  errorClass: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionStore {
  record(record: ExecutionRecord): Promise<void>;
  get(id: string): Promise<ExecutionRecord | null>;
  getForOwner(id: string, ownerId: string): Promise<ExecutionRecord | null>;
  listDue(before: string, limit?: number): Promise<ExecutionRecord[]>;
  listByOwner(ownerId: string, limit?: number, offset?: number): Promise<ExecutionRecord[]>;
  listByAgent(agentId: string, limit?: number, offset?: number): Promise<ExecutionRecord[]>;
  listStuckExecuting(limit?: number): Promise<ExecutionRecord[]>;
  listSubmitted(limit?: number): Promise<ExecutionRecord[]>;
  /** Count executions grouped by status for an owner. */
  countByOwner(ownerId: string): Promise<Record<ExecutionStatus, number>>;
  update(id: string, patch: Partial<ExecutionRecord>): Promise<ExecutionRecord | null>;
  updateIfStatus(id: string, expectedStatus: ExecutionStatus, patch: Partial<ExecutionRecord>): Promise<ExecutionRecord | null>;
  delete(id: string): Promise<boolean>;
}
