import { DatabaseSync } from "node:sqlite";
import type { PolicyRules } from "@4evergent/shared";
import { getSharedConnection } from "./shared-connection.js";

export interface PolicyConfigStore {
  get(agentId: string): Promise<PolicyRules | null>;
  getForOwner(agentId: string, ownerId: string): Promise<PolicyRules | null>;
  /** Returns rules + version + updatedAt for audit/display. */
  getWithMetadata(agentId: string): Promise<{ rules: PolicyRules; version: number; updatedAt: string } | null>;
  /** Upsert returns the stored rules and the new monotonically-increasing version. */
  upsert(agentId: string, ownerId: string, rules: PolicyRules): Promise<{ rules: PolicyRules; version: number }>;
  delete(agentId: string): Promise<boolean>;
  listByOwner(ownerId: string): Promise<Array<{ agentId: string; rules: PolicyRules }>>;
}

export class SQLitePolicyConfigStore implements PolicyConfigStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = getSharedConnection(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);

      CREATE TABLE IF NOT EXISTS policy_configs (
        agent_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        rules_json TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_policy_configs_owner ON policy_configs(owner_id);
    `);
  }

  async get(agentId: string): Promise<PolicyRules | null> {
    const row = this.db
      .prepare("SELECT rules_json FROM policy_configs WHERE agent_id = ?")
      .get(agentId) as { rules_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.rules_json) as PolicyRules;
    } catch {
      return null;
    }
  }

  async getForOwner(agentId: string, ownerId: string): Promise<PolicyRules | null> {
    const row = this.db
      .prepare("SELECT rules_json FROM policy_configs WHERE agent_id = ? AND owner_id = ?")
      .get(agentId, ownerId) as { rules_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.rules_json) as PolicyRules;
    } catch {
      return null;
    }
  }

  async getWithMetadata(agentId: string): Promise<{ rules: PolicyRules; version: number; updatedAt: string } | null> {
    const row = this.db
      .prepare("SELECT rules_json, version, updated_at FROM policy_configs WHERE agent_id = ?")
      .get(agentId) as { rules_json: string; version: number; updated_at: string } | undefined;
    if (!row) return null;
    try {
      return { rules: JSON.parse(row.rules_json) as PolicyRules, version: row.version, updatedAt: row.updated_at };
    } catch {
      return null;
    }
  }

  async upsert(agentId: string, ownerId: string, rules: PolicyRules): Promise<{ rules: PolicyRules; version: number }> {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare("SELECT version FROM policy_configs WHERE agent_id = ?")
      .get(agentId) as { version: number } | undefined;

    let newVersion: number;
    if (existing) {
      newVersion = existing.version + 1;
      this.db
        .prepare(
          `UPDATE policy_configs SET rules_json = ?, owner_id = ?, version = ?, updated_at = ? WHERE agent_id = ?`
        )
        .run(JSON.stringify(rules), ownerId, newVersion, now, agentId);
    } else {
      newVersion = 1;
      this.db
        .prepare(
          `INSERT INTO policy_configs (agent_id, owner_id, rules_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(agentId, ownerId, JSON.stringify(rules), newVersion, now, now);
    }
    return { rules, version: newVersion };
  }

  async delete(agentId: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM policy_configs WHERE agent_id = ?").run(agentId);
    return result.changes > 0;
  }

  async listByOwner(ownerId: string): Promise<Array<{ agentId: string; rules: PolicyRules }>> {
    const rows = this.db
      .prepare("SELECT agent_id, rules_json FROM policy_configs WHERE owner_id = ?")
      .all(ownerId) as Array<{ agent_id: string; rules_json: string }>;
    return rows.map((r) => ({
      agentId: r.agent_id,
      rules: JSON.parse(r.rules_json) as PolicyRules,
    }));
  }

  close(): void {
    // Shared connection — managed by closeSharedConnection() / closeAllSharedConnections()
  }
}
