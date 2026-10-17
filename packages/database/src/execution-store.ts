import { DatabaseSync } from "node:sqlite";
import type { ExecutionStore, ExecutionRecord, ExecutionStatus } from "./execution-types.js";
import { getSharedConnection } from "./shared-connection.js";
import { clampOffset, clampLimit } from "./pagination.js";

const MAX_LIMIT = 200;

/**
 * InMemoryExecutionStore — process-local execution queue.
 *
 * LIMITATION: not durable. Records are lost when the process exits. This is
 * acceptable for MVP/development. Use SQLiteExecutionStore for production.
 */
export class InMemoryExecutionStore implements ExecutionStore {
  private records = new Map<string, ExecutionRecord>();

  async record(record: ExecutionRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async get(id: string): Promise<ExecutionRecord | null> {
    return this.records.get(id) ?? null;
  }

  async getForOwner(id: string, ownerId: string): Promise<ExecutionRecord | null> {
    const rec = this.records.get(id);
    return rec?.ownerId === ownerId ? rec : null;
  }

  async listDue(before: string, limit = MAX_LIMIT): Promise<ExecutionRecord[]> {
    return [...this.records.values()]
      .filter(
        (r) =>
          (r.status === "queued" || r.status === "failed") &&
          (!r.nextRetryAt || r.nextRetryAt <= before)
      )
      .sort((a, b) => (a.nextRetryAt ?? "").localeCompare(b.nextRetryAt ?? ""))
      .slice(0, Math.max(1, Math.min(limit, MAX_LIMIT)));
  }

  async listByOwner(ownerId: string, limit = MAX_LIMIT, offset = 0): Promise<ExecutionRecord[]> {
    const safeOffset = clampOffset(offset);
    return [...this.records.values()]
      .filter((r) => r.ownerId === ownerId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(safeOffset, safeOffset + clampLimit(limit, MAX_LIMIT));
  }

  async listByAgent(agentId: string, limit = MAX_LIMIT, offset = 0): Promise<ExecutionRecord[]> {
    const safeOffset = clampOffset(offset);
    return [...this.records.values()]
      .filter((r) => r.agentId === agentId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(safeOffset, safeOffset + clampLimit(limit, MAX_LIMIT));
  }

  async listStuckExecuting(limit = MAX_LIMIT): Promise<ExecutionRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.status === "executing")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, Math.max(1, Math.min(limit, MAX_LIMIT)));
  }

  async listSubmitted(limit = MAX_LIMIT): Promise<ExecutionRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.status === "submitted")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, Math.max(1, Math.min(limit, MAX_LIMIT)));
  }

  async countByOwner(ownerId: string): Promise<Record<ExecutionStatus, number>> {
    const counts: Record<string, number> = {};
    for (const r of this.records.values()) {
      if (r.ownerId !== ownerId) continue;
      counts[r.status] = (counts[r.status] ?? 0) + 1;
    }
    const result: Record<ExecutionStatus, number> = {
      queued: 0, executing: 0, submitted: 0,
      confirmed: 0, failed: 0, dead_letter: 0,
    };
    for (const [status, count] of Object.entries(counts)) {
      result[status as ExecutionStatus] = count;
    }
    return result;
  }

  async update(id: string, patch: Partial<ExecutionRecord>): Promise<ExecutionRecord | null> {
    const existing = this.records.get(id);
    if (!existing) return null;
    const updated: ExecutionRecord = { ...existing, ...patch, id: existing.id };
    this.records.set(id, updated);
    return updated;
  }

  async updateIfStatus(id: string, expectedStatus: ExecutionStatus, patch: Partial<ExecutionRecord>): Promise<ExecutionRecord | null> {
    const existing = this.records.get(id);
    if (!existing || existing.status !== expectedStatus) return null;
    const updated: ExecutionRecord = { ...existing, ...patch, id: existing.id };
    this.records.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
}

interface ExecutionRow {
  id: string;
  owner_id: string;
  agent_id: string;
  approval_id: string | null;
  activity_id: string | null;
  intent_json: string;
  status: string;
  policy_decision_json: string | null;
  simulation_result_json: string | null;
  tx_hash: string | null;
  submitted_hash: string | null;
  error: string | null;
  attempt: number;
  next_retry_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  error_class: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * SQLiteExecutionStore — persistent ExecutionStore backed by SQLite.
 *
 * Uses Node.js built-in node:sqlite (Node 22+). Schema versioned in _meta
 * (version 1). initSchema() is idempotent. Records survive process restart.
 */
export class SQLiteExecutionStore implements ExecutionStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = getSharedConnection(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);

      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        approval_id TEXT,
        activity_id TEXT,
        intent_json TEXT NOT NULL,
        status TEXT NOT NULL,
        policy_decision_json TEXT,
        simulation_result_json TEXT,
        tx_hash TEXT,
        submitted_hash TEXT,
        error TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        next_retry_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        error_class TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_executions_owner ON executions(owner_id);
      CREATE INDEX IF NOT EXISTS idx_executions_agent ON executions(agent_id);
      CREATE INDEX IF NOT EXISTS idx_executions_status ON executions(status);
      CREATE INDEX IF NOT EXISTS idx_executions_next_retry ON executions(next_retry_at);
    `);
    try {
      this.db.exec(`ALTER TABLE executions ADD COLUMN submitted_hash TEXT`);
    } catch {
      // Column already exists (new schema or previously migrated).
    }
  }

  async record(record: ExecutionRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO executions
         (id, owner_id, agent_id, approval_id, activity_id, intent_json, status,
          policy_decision_json, simulation_result_json, tx_hash, submitted_hash, error, attempt,
          next_retry_at, started_at, completed_at, error_class, created_at, updated_at)
         VALUES
         (@id, @owner_id, @agent_id, @approval_id, @activity_id, @intent_json, @status,
          @policy_decision_json, @simulation_result_json, @tx_hash, @submitted_hash, @error, @attempt,
          @next_retry_at, @started_at, @completed_at, @error_class, @created_at, @updated_at)`
      )
      .run({
        id: record.id,
        owner_id: record.ownerId,
        agent_id: record.agentId,
        approval_id: record.approvalId,
        activity_id: record.activityId,
        intent_json: JSON.stringify(record.intent),
        status: record.status,
        policy_decision_json: record.policyDecision ? JSON.stringify(record.policyDecision) : null,
        simulation_result_json: record.simulationResult ? JSON.stringify(record.simulationResult) : null,
        tx_hash: record.txHash,
        submitted_hash: record.submittedHash ?? null,
        error: record.error,
        attempt: record.attempt,
        next_retry_at: record.nextRetryAt,
        started_at: record.startedAt,
        completed_at: record.completedAt,
        error_class: record.errorClass,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      });
  }

  async get(id: string): Promise<ExecutionRecord | null> {
    const row = this.db.prepare("SELECT * FROM executions WHERE id = ?").get(id) as unknown as ExecutionRow | undefined;
    return row ? rowToExecutionRecord(row) : null;
  }

  async getForOwner(id: string, ownerId: string): Promise<ExecutionRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM executions WHERE id = ? AND owner_id = ?")
      .get(id, ownerId) as unknown as ExecutionRow | undefined;
    return row ? rowToExecutionRecord(row) : null;
  }

  async listDue(before: string, limit = MAX_LIMIT): Promise<ExecutionRecord[]> {
    const safeLimit = Math.max(1, Math.min(limit, MAX_LIMIT));
    const rows = this.db
      .prepare(
        `SELECT * FROM executions
         WHERE (status = 'queued' OR status = 'failed')
           AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ORDER BY next_retry_at ASC
         LIMIT ?`
      )
      .all(before, safeLimit) as unknown as ExecutionRow[];
    return rows.map(rowToExecutionRecord);
  }

  async listByOwner(ownerId: string, limit = MAX_LIMIT, offset = 0): Promise<ExecutionRecord[]> {
    const safeLimit = clampLimit(limit, MAX_LIMIT);
    const safeOffset = clampOffset(offset);
    const rows = this.db
      .prepare("SELECT * FROM executions WHERE owner_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?")
      .all(ownerId, safeLimit, safeOffset) as unknown as ExecutionRow[];
    return rows.map(rowToExecutionRecord);
  }

  async listByAgent(agentId: string, limit = MAX_LIMIT, offset = 0): Promise<ExecutionRecord[]> {
    const safeLimit = clampLimit(limit, MAX_LIMIT);
    const safeOffset = clampOffset(offset);
    const rows = this.db
      .prepare("SELECT * FROM executions WHERE agent_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?")
      .all(agentId, safeLimit, safeOffset) as unknown as ExecutionRow[];
    return rows.map(rowToExecutionRecord);
  }

  async listStuckExecuting(limit = MAX_LIMIT): Promise<ExecutionRecord[]> {
    const safeLimit = Math.max(1, Math.min(limit, MAX_LIMIT));
    const rows = this.db
      .prepare("SELECT * FROM executions WHERE status = 'executing' ORDER BY created_at ASC LIMIT ?")
      .all(safeLimit) as unknown as ExecutionRow[];
    return rows.map(rowToExecutionRecord);
  }

  async listSubmitted(limit = MAX_LIMIT): Promise<ExecutionRecord[]> {
    const safeLimit = Math.max(1, Math.min(limit, MAX_LIMIT));
    const rows = this.db
      .prepare("SELECT * FROM executions WHERE status = 'submitted' ORDER BY created_at ASC LIMIT ?")
      .all(safeLimit) as unknown as ExecutionRow[];
    return rows.map(rowToExecutionRecord);
  }

  async countByOwner(ownerId: string): Promise<Record<ExecutionStatus, number>> {
    const rows = this.db
      .prepare(
        "SELECT status, COUNT(*) as count FROM executions WHERE owner_id = ? GROUP BY status"
      )
      .all(ownerId) as unknown as Array<{ status: string; count: number }>;
    const result: Record<ExecutionStatus, number> = {
      queued: 0, executing: 0, submitted: 0,
      confirmed: 0, failed: 0, dead_letter: 0,
    };
    for (const row of rows) {
      const s = row.status as ExecutionStatus;
      if (s in result) result[s] = row.count;
    }
    return result;
  }

  async update(id: string, patch: Partial<ExecutionRecord>): Promise<ExecutionRecord | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const updated: ExecutionRecord = { ...existing, ...patch, id: existing.id };
    this.db
      .prepare(
        `UPDATE executions SET
           owner_id = @owner_id, agent_id = @agent_id, approval_id = @approval_id,
           activity_id = @activity_id, intent_json = @intent_json, status = @status,
           policy_decision_json = @policy_decision_json, simulation_result_json = @simulation_result_json,
           tx_hash = @tx_hash, submitted_hash = @submitted_hash, error = @error, attempt = @attempt,
           next_retry_at = @next_retry_at,
           started_at = @started_at, completed_at = @completed_at, error_class = @error_class,
           updated_at = @updated_at
         WHERE id = @id`
      )
      .run({
        id: updated.id,
        owner_id: updated.ownerId,
        agent_id: updated.agentId,
        approval_id: updated.approvalId,
        activity_id: updated.activityId,
        intent_json: JSON.stringify(updated.intent),
        status: updated.status,
        policy_decision_json: updated.policyDecision ? JSON.stringify(updated.policyDecision) : null,
        simulation_result_json: updated.simulationResult ? JSON.stringify(updated.simulationResult) : null,
        tx_hash: updated.txHash,
        submitted_hash: updated.submittedHash ?? null,
        error: updated.error,
        attempt: updated.attempt,
        next_retry_at: updated.nextRetryAt,
        started_at: updated.startedAt,
        completed_at: updated.completedAt,
        error_class: updated.errorClass,
        updated_at: updated.updatedAt,
      });
    return updated;
  }

  async updateIfStatus(id: string, expectedStatus: ExecutionStatus, patch: Partial<ExecutionRecord>): Promise<ExecutionRecord | null> {
    const existing = await this.get(id);
    if (!existing || existing.status !== expectedStatus) return null;
    const updated: ExecutionRecord = { ...existing, ...patch, id: existing.id };
    const result = this.db
      .prepare(
        `UPDATE executions SET
           owner_id = @owner_id, agent_id = @agent_id, approval_id = @approval_id,
           activity_id = @activity_id, intent_json = @intent_json, status = @status,
           policy_decision_json = @policy_decision_json, simulation_result_json = @simulation_result_json,
           tx_hash = @tx_hash, submitted_hash = @submitted_hash, error = @error, attempt = @attempt,
           next_retry_at = @next_retry_at,
           started_at = @started_at, completed_at = @completed_at, error_class = @error_class,
           updated_at = @updated_at
         WHERE id = @id AND status = @expected_status`
      )
      .run({
        id: updated.id,
        owner_id: updated.ownerId,
        agent_id: updated.agentId,
        approval_id: updated.approvalId,
        activity_id: updated.activityId,
        intent_json: JSON.stringify(updated.intent),
        status: updated.status,
        policy_decision_json: updated.policyDecision ? JSON.stringify(updated.policyDecision) : null,
        simulation_result_json: updated.simulationResult ? JSON.stringify(updated.simulationResult) : null,
        tx_hash: updated.txHash,
        submitted_hash: updated.submittedHash ?? null,
        error: updated.error,
        attempt: updated.attempt,
        next_retry_at: updated.nextRetryAt,
        started_at: updated.startedAt,
        completed_at: updated.completedAt,
        error_class: updated.errorClass,
        updated_at: updated.updatedAt,
        expected_status: expectedStatus,
      } as any);
    if (result.changes === 0) return null;
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM executions WHERE id = ?").run(id);
    return result.changes > 0;
  }

  close(): void {
    // Shared connection — managed by closeSharedConnection() / closeAllSharedConnections()
  }
}

function rowToExecutionRecord(r: ExecutionRow): ExecutionRecord {
  return {
    id: r.id,
    ownerId: r.owner_id,
    agentId: r.agent_id,
    approvalId: r.approval_id,
    activityId: r.activity_id,
    intent: JSON.parse(r.intent_json),
    status: r.status as ExecutionRecord["status"],
    policyDecision: r.policy_decision_json ? JSON.parse(r.policy_decision_json) : null,
    simulationResult: r.simulation_result_json ? JSON.parse(r.simulation_result_json) : null,
    txHash: r.tx_hash,
    submittedHash: r.submitted_hash,
    error: r.error,
    attempt: r.attempt,
    nextRetryAt: r.next_retry_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    errorClass: r.error_class,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
