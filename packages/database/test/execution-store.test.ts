import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import {
  InMemoryExecutionStore,
  SQLiteExecutionStore,
  type ExecutionStore,
  type ExecutionRecord,
  type ExecutionStatus,
} from "../src/index.js";
import type { AgentIntent } from "@4evergent/shared";

function makeIntent(): AgentIntent {
  return {
    type: "payment",
    asset: "XLM",
    destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    amount: "10",
    reason: "test",
  };
}

function makeExecution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    ownerId: "owner-a",
    agentId: "agent-a",
    approvalId: null,
    activityId: null,
    intent: makeIntent(),
    status: "queued",
    policyDecision: null,
    simulationResult: null,
    txHash: null,
    submittedHash: null,
    error: null,
    attempt: 0,
    nextRetryAt: null,
    startedAt: null,
    completedAt: null,
    errorClass: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function runExecutionStoreTests(
  name: string,
  makeStore: () => { store: ExecutionStore; cleanup?: () => void }
) {
  test(`${name}: records and reads cancelled execution`, async () => {
    const { store, cleanup } = makeStore();
    try {
      const now = new Date().toISOString();
      const rec = makeExecution({
        status: "cancelled",
        completedAt: now,
        error: "cancelled by user",
      });
      await store.record(rec);

      const got = await store.get(rec.id);
      assert.ok(got);
      assert.equal(got.id, rec.id);
      assert.equal(got.status, "cancelled");
      assert.equal(got.error, "cancelled by user");
      assert.equal(got.completedAt, now);

      const gotForOwner = await store.getForOwner(rec.id, "owner-a");
      assert.ok(gotForOwner);
      assert.equal(gotForOwner.status, "cancelled");
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: countByOwner tracks cancelled status separately from dead_letter and failed`, async () => {
    const { store, cleanup } = makeStore();
    try {
      const statuses: ExecutionStatus[] = [
        "queued",
        "executing",
        "submitted",
        "confirmed",
        "failed",
        "dead_letter",
        "cancelled",
      ];
      for (const s of statuses) {
        await store.record(makeExecution({ id: `exec-${s}`, status: s, ownerId: "owner-count" }));
      }
      // Also record an execution for another owner to ensure owner isolation
      await store.record(makeExecution({ id: "exec-other", status: "cancelled", ownerId: "owner-other" }));

      const counts = await store.countByOwner("owner-count");
      assert.deepEqual(counts, {
        queued: 1,
        executing: 1,
        submitted: 1,
        confirmed: 1,
        failed: 1,
        dead_letter: 1,
        cancelled: 1,
      });

      const otherCounts = await store.countByOwner("owner-other");
      assert.equal(otherCounts.cancelled, 1);
      assert.equal(otherCounts.dead_letter, 0);
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: updateIfStatus atomically transitions queued and executing to cancelled`, async () => {
    const { store, cleanup } = makeStore();
    try {
      const queuedRec = makeExecution({ status: "queued" });
      const executingRec = makeExecution({ status: "executing" });
      await store.record(queuedRec);
      await store.record(executingRec);

      const now = new Date().toISOString();

      // Transition queued → cancelled
      const updatedQueued = await store.updateIfStatus(queuedRec.id, "queued", {
        status: "cancelled",
        error: "cancelled by user",
        completedAt: now,
      });
      assert.ok(updatedQueued);
      assert.equal(updatedQueued.status, "cancelled");
      assert.equal(updatedQueued.error, "cancelled by user");

      // Transition executing → cancelled
      const updatedExecuting = await store.updateIfStatus(executingRec.id, "executing", {
        status: "cancelled",
        error: "cancelled by user",
        completedAt: now,
      });
      assert.ok(updatedExecuting);
      assert.equal(updatedExecuting.status, "cancelled");
      assert.equal(updatedExecuting.error, "cancelled by user");

      // Race guard: updateIfStatus fails if expected status does not match current status
      const mismatch = await store.updateIfStatus(queuedRec.id, "queued", {
        status: "dead_letter",
      });
      assert.equal(mismatch, null);
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: migration note verification — historical dead_letter records with error 'cancelled by user' are preserved`, async () => {
    const { store, cleanup } = makeStore();
    try {
      const historicalRec = makeExecution({
        status: "dead_letter",
        error: "cancelled by user",
        completedAt: "2025-12-01T00:00:00.000Z",
      });
      await store.record(historicalRec);

      const got = await store.get(historicalRec.id);
      assert.ok(got);
      assert.equal(got.status, "dead_letter");
      assert.equal(got.error, "cancelled by user");

      const counts = await store.countByOwner("owner-a");
      assert.equal(counts.dead_letter, 1);
      assert.equal(counts.cancelled, 0);
    } finally {
      cleanup?.();
    }
  });
}

runExecutionStoreTests("InMemoryExecutionStore", () => ({
  store: new InMemoryExecutionStore(),
}));

runExecutionStoreTests("SQLiteExecutionStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-store-test-"));
  const dbPath = join(dir, "exec.db");
  const store = new SQLiteExecutionStore(dbPath);
  return {
    store,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
});
