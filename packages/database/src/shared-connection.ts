import { DatabaseSync } from "node:sqlite";

const connections = new Map<string, DatabaseSync>();

export function getSharedConnection(dbPath: string): DatabaseSync {
  const existing = connections.get(dbPath);
  if (existing) return existing;
  const db = new DatabaseSync(dbPath);
  // WAL allows readers to continue while another connection writes. These
  // connection settings apply to every store sharing this connection.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);");
  db.exec("INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '5');");
  connections.set(dbPath, db);
  return db;
}

export function getSchemaVersion(db: DatabaseSync): number | null {
  const row = db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  if (!row) return null;
  const parsed = parseInt(row.value, 10);
  return isNaN(parsed) ? null : parsed;
}

export function setSchemaVersion(db: DatabaseSync, version: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?)",
  ).run(String(version));
}

export function closeSharedConnection(dbPath: string): void {
  const db = connections.get(dbPath);
  if (db) {
    db.close();
    connections.delete(dbPath);
  }
}

export function closeAllSharedConnections(): void {
  for (const db of connections.values()) {
    db.close();
  }
  connections.clear();
}
