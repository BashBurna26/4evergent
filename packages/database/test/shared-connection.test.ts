import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getSharedConnection,
  getSchemaVersion,
  setSchemaVersion,
  closeSharedConnection,
  closeAllSharedConnections,
} from "../src/shared-connection.js";
import { SQLiteActivityStore } from "../src/sqlite-store.js";
import { SQLiteAgentStore } from "../src/agent-store.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "shared-conn-test-"));
  tmpDirs.push(d);
  return d;
}

function cleanup() {
  closeAllSharedConnections();
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
}

test("returns same DatabaseSync instance for same dbPath", () => {
  const dir = makeTmpDir();
  const dbPath = join(dir, "test.db");
  const db1 = getSharedConnection(dbPath);
  const db2 = getSharedConnection(dbPath);
  assert.equal(db1, db2);
  cleanup();
});

test("configures WAL, busy_timeout, and synchronous mode on every shared connection", () => {
  const dir = makeTmpDir();
  const db = getSharedConnection(join(dir, "pragmas.db"));
  assert.equal((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
  assert.equal((db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout, 5000);
  assert.equal((db.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous, 1);
  cleanup();
});

test("returns different instances for different dbPaths", () => {
  const dir = makeTmpDir();
  const db1 = getSharedConnection(join(dir, "a.db"));
  const db2 = getSharedConnection(join(dir, "b.db"));
  assert.notEqual(db1, db2);
  cleanup();
});

test("getSchemaVersion returns 5 (set by shared-connection on creation)", () => {
  const dir = makeTmpDir();
  const db = getSharedConnection(join(dir, "test.db"));
  assert.equal(getSchemaVersion(db), 5);
  cleanup();
});

test("setSchemaVersion overwrites and getSchemaVersion reads back", () => {
  const dir = makeTmpDir();
  const db = getSharedConnection(join(dir, "test.db"));
  setSchemaVersion(db, 42);
  assert.equal(getSchemaVersion(db), 42);
  cleanup();
});

test("closeSharedConnection removes instance from registry", () => {
  const dir = makeTmpDir();
  const dbPath = join(dir, "test.db");
  const db1 = getSharedConnection(dbPath);
  closeSharedConnection(dbPath);
  const db2 = getSharedConnection(dbPath);
  assert.notEqual(db1, db2);
  cleanup();
});

test("stores sharing same dbPath use same underlying connection", () => {
  const dir = makeTmpDir();
  const dbPath = join(dir, "test.db");
  const store1 = new SQLiteActivityStore(dbPath);
  const store2 = new SQLiteAgentStore(dbPath);
  store1.close();
  store2.close();

  const db = getSharedConnection(dbPath);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  const tableNames = tables.map((t) => t.name);
  assert.ok(tableNames.includes("activities"), "activities table should exist");
  assert.ok(tableNames.includes("agents"), "agents table should exist");
  cleanup();
});

test("concurrent writes through shared connection do not deadlock", async () => {
  const dir = makeTmpDir();
  const dbPath = join(dir, "test.db");
  const db = getSharedConnection(dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS test_concurrent (id INTEGER PRIMARY KEY, val TEXT);");

  const promises: Promise<void>[] = [];
  for (let i = 0; i < 20; i++) {
    promises.push(
      (async () => {
        db.prepare("INSERT INTO test_concurrent (val) VALUES (?)").run(`val-${i}`);
      })(),
    );
  }

  await Promise.all(promises);

  const result = db.prepare("SELECT COUNT(*) as c FROM test_concurrent").get() as { c: number };
  assert.equal(result.c, 20);
  cleanup();
});

test("concurrent writes from two stores on the same path complete without SQLITE_BUSY", async () => {
  const dir = makeTmpDir();
  const dbPath = join(dir, "two-stores.db");
  const first = new SQLiteAgentStore(dbPath);
  const second = new SQLiteAgentStore(dbPath);
  const writes = Array.from({ length: 20 }, (_, index) =>
    (index % 2 === 0 ? first : second).create({
      id: `agent-${index}`,
      displayName: `Agent ${index}`,
      ownerId: "owner-a",
    }),
  );
  const created = await Promise.all(writes);
  assert.equal(created.length, 20);
  assert.equal((await first.listByOwner("owner-a")).length, 20);
  cleanup();
});
