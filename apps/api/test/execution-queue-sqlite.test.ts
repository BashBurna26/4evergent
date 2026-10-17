import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SQLiteExecutionStore,
  closeAllSharedConnections,
} from "@4evergent/database";
import type { ExecutionRecord, ExecutionResult } from "@4evergent/database";
import type { AgentIntent } from "@4evergent/shared";
import { ExecutionQueue } from "../src/execution-queue.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "queue-sqlite-test-"));
  tmpDirs.push(dir);
  return dir;
}

function cleanup(): void {
  closeAllSharedConnections();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeIntent(): AgentIntent {
  return {
    type: "payment",
    asset: "XLM",
    destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    amount: "10",
    reason: "test execution",
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

const sourceAccount = async () => ({
  accountId: () => "GACCOUNT",
  sequenceNumber: () => "1",
  incrementSequenceNumber: () => {},
});

const retryPolicy = { maxRetries: 2, baseDelayMs: 5_000, maxDelayMs: 60_000 };

test("SQLite queue: transient failure backs off, then retries and succeeds", async () => {
  const dbPath = join(makeTmpDir(), "retry.db");
  const base = new Date("2026-01-01T00:00:00.000Z");
  const store = new SQLiteExecutionStore(dbPath);
  let calls = 0;
  const executor = async (record: ExecutionRecord): Promise<ExecutionResult> => {
    calls++;
    if (calls === 1) {
      return {
        record,
        success: false,
        status: "rejected",
        error: "network timeout",
        errorClass: "transient",
      };
    }
    return { record, success: true, status: "submitted", txHash: "tx-retried" };
  };
  const queue = new ExecutionQueue(store, executor, sourceAccount, {
    retryPolicy,
    now: () => base,
  });

  const execution = makeExecution();
  await queue.enqueue(execution);
  assert.equal(await queue.processDue(base.toISOString()), 1);

  const failed = await store.get(execution.id);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.attempt, 1);
  // The queue passes the post-increment attempt to computeNextRetryAt, so the
  // first retry waits baseDelay * 2^1 = 10s.
  assert.equal(failed?.nextRetryAt, "2026-01-01T00:00:10.000Z", "retry must respect exponential backoff");

  // Not due before the backoff elapses — this is what prevents a hot retry loop.
  assert.equal(await queue.processDue("2026-01-01T00:00:09.999Z"), 0);
  assert.equal(calls, 1);

  // Due once the backoff has elapsed.
  assert.equal(await queue.processDue("2026-01-01T00:00:10.000Z"), 1);
  const submitted = await store.get(execution.id);
  assert.equal(submitted?.status, "submitted");
  assert.equal(submitted?.txHash, "tx-retried");
  assert.equal(submitted?.attempt, 1, "attempt count survives the retry cycle");
  assert.equal(calls, 2);
  cleanup();
});

test("SQLite queue: exhausted retries stop at dead_letter and are never reprocessed", async () => {
  const dbPath = join(makeTmpDir(), "dead-letter.db");
  const base = new Date("2026-01-01T00:00:00.000Z");
  const store = new SQLiteExecutionStore(dbPath);
  let calls = 0;
  const executor = async (record: ExecutionRecord): Promise<ExecutionResult> => {
    calls++;
    return {
      record,
      success: false,
      status: "rejected",
      error: "network timeout",
      errorClass: "transient",
    };
  };
  const queue = new ExecutionQueue(store, executor, sourceAccount, {
    retryPolicy,
    now: () => base,
  });

  const execution = makeExecution();
  await queue.enqueue(execution);

  // maxRetries = 2 → attempt 1 is retried, attempt 2 is dead-lettered.
  assert.equal(await queue.processDue(base.toISOString()), 1);
  assert.equal(await queue.processDue("2026-01-01T00:00:10.000Z"), 1);

  const final = await store.get(execution.id);
  assert.equal(final?.status, "dead_letter");
  assert.equal(final?.attempt, 2);
  assert.equal(final?.nextRetryAt, null);
  assert.equal(calls, 2);

  // Terminal: no amount of time makes it eligible again.
  assert.equal(await queue.processDue("2099-01-01T00:00:00.000Z"), 0);
  assert.equal(calls, 2);
  cleanup();
});

test("SQLite queue: queued work survives a process restart", async () => {
  const dbPath = join(makeTmpDir(), "restart.db");
  const execution = makeExecution({ status: "queued" });

  const first = new SQLiteExecutionStore(dbPath);
  await first.record(execution);

  // Simulate the API process exiting and a new one opening the same DATABASE_PATH.
  closeAllSharedConnections();
  const second = new SQLiteExecutionStore(dbPath);

  let executed = 0;
  const queue = new ExecutionQueue(
    second,
    async (record) => {
      executed++;
      return { record, success: true, status: "submitted", txHash: "tx-after-restart" };
    },
    sourceAccount
  );

  assert.equal(await queue.processDue(), 1);
  assert.equal(executed, 1);

  const final = await second.get(execution.id);
  assert.equal(final?.status, "submitted");
  assert.equal(final?.txHash, "tx-after-restart");
  cleanup();
});

test("SQLite queue: two workers sharing one database execute a record once", async () => {
  const dbPath = join(makeTmpDir(), "two-workers.db");
  const storeA = new SQLiteExecutionStore(dbPath);
  const storeB = new SQLiteExecutionStore(dbPath);

  const execution = makeExecution();
  await storeA.record(execution);

  let executions = 0;
  const executor = async (record: ExecutionRecord): Promise<ExecutionResult> => {
    executions++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { record, success: true, status: "submitted", txHash: "tx-once" };
  };

  const queueA = new ExecutionQueue(storeA, executor, sourceAccount);
  const queueB = new ExecutionQueue(storeB, executor, sourceAccount);

  const [startedA, startedB] = await Promise.all([queueA.processDue(), queueB.processDue()]);

  assert.equal(startedA + startedB, 1, "only one worker may claim the execution");
  assert.equal(executions, 1, "the pipeline must not run twice for one record");
  assert.equal((await storeA.get(execution.id))?.status, "submitted");
  cleanup();
});

test.after(() => cleanup());
