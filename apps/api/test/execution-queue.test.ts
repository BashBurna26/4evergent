import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryExecutionStore,
  classifyPipelineOutcome,
  classifyError,
  shouldRetry,
  computeNextRetryAt,
} from "@4evergent/database";
import { ExecutionQueue } from "../src/execution-queue.js";
import type { ExecutionRecord, ExecutionResult } from "@4evergent/database";
import type { AgentIntent } from "@4evergent/shared";

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

function makePipelineExecutor(result: ExecutionResult) {
  return async (_record: ExecutionRecord): Promise<ExecutionResult> => result;
}

test("ExecutionQueue: enqueue + processDue success path", async () => {
  const store = new InMemoryExecutionStore();
  let executed = 0;
  const pipelineExecutor = async (record: ExecutionRecord): Promise<ExecutionResult> => {
    executed++;
    return {
      record,
      success: true,
      status: "submitted",
      txHash: "tx-123",
      error: null,
      errorClass: null,
    };
  };
  const queue = new ExecutionQueue(store, pipelineExecutor, async () => ({
    accountId: () => "GACCOUNT",
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
  }));
  const execution = makeExecution();
  await queue.enqueue(execution);
  const started = await queue.processDue();
  assert.equal(started, 1);
  assert.equal(executed, 1);
  const updated = await store.get(execution.id);
  assert.equal(updated?.status, "submitted");
  assert.equal(updated?.txHash, "tx-123");
});

test("ExecutionQueue: fails after max retries → dead_letter", async () => {
  const store = new InMemoryExecutionStore();
  const pipelineExecutor = makePipelineExecutor({
    record: makeExecution(),
    success: false,
    status: "rejected",
    error: "permanent failure",
    errorClass: "permanent",
  });
  const queue = new ExecutionQueue(store, pipelineExecutor, async () => ({
    accountId: () => "GACCOUNT",
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
  }), { retryPolicy: { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50 } });
  const execution = makeExecution();
  await queue.enqueue(execution);
  await queue.processDue();
  const updated = await store.get(execution.id);
  assert.equal(updated?.status, "dead_letter");
  assert.equal(updated?.attempt, 1);
});

test("ExecutionQueue: transient failure → retry scheduled", async () => {
  const store = new InMemoryExecutionStore();
  const pipelineExecutor = makePipelineExecutor({
    record: makeExecution(),
    success: false,
    status: "rejected",
    error: "network timeout",
    errorClass: "transient",
  });
  const queue = new ExecutionQueue(store, pipelineExecutor, async () => ({
    accountId: () => "GACCOUNT",
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
  }), { retryPolicy: { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50 } });
  const execution = makeExecution();
  await queue.enqueue(execution);
  await queue.processDue();
  const updated = await store.get(execution.id);
  assert.equal(updated?.status, "failed");
  assert.ok(updated?.nextRetryAt);
});

test("ExecutionQueue: permanent failure → no retry", async () => {
  const store = new InMemoryExecutionStore();
  const pipelineExecutor = makePipelineExecutor({
    record: makeExecution(),
    success: false,
    status: "rejected",
    error: "invalid intent",
    errorClass: "permanent",
  });
  const queue = new ExecutionQueue(store, pipelineExecutor, async () => ({
    accountId: () => "GACCOUNT",
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
  }));
  const execution = makeExecution();
  await queue.enqueue(execution);
  await queue.processDue();
  const updated = await store.get(execution.id);
  assert.equal(updated?.status, "dead_letter");
  assert.equal(updated?.nextRetryAt, null);
});

test("ExecutionQueue: crash recovery — failed record can be reprocessed", async () => {
  const store = new InMemoryExecutionStore();
  let callCount = 0;
  const pipelineExecutor = async (record: ExecutionRecord): Promise<ExecutionResult> => {
    callCount++;
    if (callCount === 1) {
      // Simulate crash during first execution — record stays in "failed"
      return {
        record,
        success: false,
        status: "rejected",
        error: "transient failure",
        errorClass: "transient",
      };
    }
    return {
      record,
      success: true,
      status: "submitted",
      txHash: "tx-retry",
      error: null,
    };
  };
  const queue = new ExecutionQueue(store, pipelineExecutor, async () => ({
    accountId: () => "GACCOUNT",
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
  }), { retryPolicy: { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50 } });

  const execution = makeExecution();
  await queue.enqueue(execution);

  // First pass: fails, goes to "failed" with retry scheduled
  await queue.processDue();
  const afterFirst = await store.get(execution.id);
  assert.equal(afterFirst?.status, "failed");
  assert.ok(afterFirst?.nextRetryAt);

  // Simulate crash recovery: create a new queue instance pointing at the
  // same store, then processDue again with a future timestamp that exceeds
  // nextRetryAt.
  const recoveredQueue = new ExecutionQueue(store, pipelineExecutor, async () => ({
    accountId: () => "GACCOUNT",
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
  }), { retryPolicy: { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50 } });

  await recoveredQueue.processDue(new Date(Date.now() + 60_000).toISOString());

  const finalRecord = await store.get(execution.id);
  assert.equal(finalRecord?.status, "submitted");
  assert.equal(finalRecord?.txHash, "tx-retry");
  assert.equal(callCount, 2);
});

test("ExecutionQueue: duplicate safety — skips already-executing record", async () => {
  const store = new InMemoryExecutionStore();
  let executed = 0;
  const pipelineExecutor = async (record: ExecutionRecord): Promise<ExecutionResult> => {
    executed++;
    return {
      record,
      success: true,
      status: "submitted",
      txHash: "tx",
      error: null,
    };
  };
  const queue = new ExecutionQueue(store, pipelineExecutor, async () => ({
    accountId: () => "GACCOUNT",
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
  }));

  const execution = makeExecution({ status: "executing", startedAt: new Date().toISOString() });
  await store.record(execution);

  const started = await queue.processDue();
  assert.equal(started, 0);
  assert.equal(executed, 0);
});

test("classifyError: network errors are transient", () => {
  assert.equal(classifyError(new Error("network timeout")), "transient");
  assert.equal(classifyError(new Error("ENOTFOUND")), "transient");
  assert.equal(classifyError(new Error("invalid intent")), "permanent");
  assert.equal(classifyError(new Error("Horizon unavailable")), "transient");
});

test("classifyPipelineOutcome: simulation_failed with network error is transient", () => {
  const outcome = { status: "simulation_failed", message: "network error" };
  assert.equal(classifyPipelineOutcome(outcome), "transient");
});

test("classifyPipelineOutcome: simulation_failed without network is permanent", () => {
  const outcome = { status: "simulation_failed", message: "bad sequence" };
  assert.equal(classifyPipelineOutcome(outcome), "permanent");
});

test("shouldRetry: permanent never retries", () => {
  assert.equal(shouldRetry(0, "permanent"), false);
  assert.equal(shouldRetry(1, "permanent"), false);
});

test("shouldRetry: transient retries up to maxRetries", () => {
  const policy = { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 1000 };
  assert.equal(shouldRetry(0, "transient", policy), true);
  assert.equal(shouldRetry(1, "transient", policy), true);
  assert.equal(shouldRetry(2, "transient", policy), true);
  assert.equal(shouldRetry(3, "transient", policy), false);
});

test("computeNextRetryAt: exponential backoff", () => {
  const policy = { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 10000 };
  const now = new Date("2026-01-01T00:00:00Z");
  // attempt 0 → baseDelay * 2^0 = 1s
  const r0 = computeNextRetryAt(0, policy, now);
  assert.equal(r0, new Date("2026-01-01T00:00:01Z").toISOString());
  // attempt 1 → baseDelay * 2^1 = 2s
  const r1 = computeNextRetryAt(1, policy, now);
  assert.equal(r1, new Date("2026-01-01T00:00:02Z").toISOString());
  // attempt 2 → baseDelay * 2^2 = 4s
  const r2 = computeNextRetryAt(2, policy, now);
  assert.equal(r2, new Date("2026-01-01T00:00:04Z").toISOString());
  // attempt 3 → baseDelay * 2^3 = 8s
  const r3 = computeNextRetryAt(3, policy, now);
  assert.equal(r3, new Date("2026-01-01T00:00:08Z").toISOString());
});

test("computeNextRetryAt: capped at maxDelayMs", () => {
  const policy = { maxRetries: 10, baseDelayMs: 1000, maxDelayMs: 5000 };
  const now = new Date("2026-01-01T00:00:00Z");
  const result = computeNextRetryAt(5, policy, now);
  assert.equal(result, new Date("2026-01-01T00:00:05Z").toISOString());
});

test("ExecutionQueue.cancel: queued → cancelled with completedAt and error", async () => {
  const store = new InMemoryExecutionStore();
  const queue = new ExecutionQueue(store, async (rec) => ({ record: rec, success: true }));
  const execution = makeExecution({ status: "queued", nextRetryAt: "2026-01-01T00:00:00Z" });
  await store.record(execution);

  const res = await queue.cancel(execution.id);
  assert.equal(res.status, "cancelled");
  assert.ok(res.execution);
  assert.equal(res.execution.status, "cancelled");
  assert.equal(res.execution.error, "cancelled by user");
  assert.equal(res.execution.nextRetryAt, null);
  assert.equal(res.execution.startedAt, null);
  assert.ok(res.execution.completedAt);

  const stored = await store.get(execution.id);
  assert.equal(stored?.status, "cancelled");
});

test("ExecutionQueue.cancel: executing → cancelled", async () => {
  const store = new InMemoryExecutionStore();
  const queue = new ExecutionQueue(store, async (rec) => ({ record: rec, success: true }));
  const execution = makeExecution({ status: "executing", startedAt: "2026-01-01T00:00:00Z" });
  await store.record(execution);

  const res = await queue.cancel(execution.id);
  assert.equal(res.status, "cancelled");
  assert.equal(res.execution?.status, "cancelled");
  assert.equal(res.execution?.error, "cancelled by user");
});

test("ExecutionQueue.cancel: rejects non-cancellable states and nonexistent ids", async () => {
  const store = new InMemoryExecutionStore();
  const queue = new ExecutionQueue(store, async (rec) => ({ record: rec, success: true }));

  const notFound = await queue.cancel("nonexistent");
  assert.equal(notFound.status, "not_found");

  for (const s of ["submitted", "confirmed", "failed", "dead_letter", "cancelled"] as const) {
    const exec = makeExecution({ id: `id-${s}`, status: s });
    await store.record(exec);
    const res = await queue.cancel(exec.id);
    assert.equal(res.status, "invalid_state");
  }
});

test("ExecutionQueue.cancel: preserves atomic conditional update conflict guard", async () => {
  const store = new InMemoryExecutionStore();
  const queue = new ExecutionQueue(store, async (rec) => ({ record: rec, success: true }));
  const execution = makeExecution({ status: "queued" });
  await store.record(execution);

  // Simulate concurrent update before cancel completes
  const originalUpdateIfStatus = store.updateIfStatus.bind(store);
  store.updateIfStatus = async (id, expected, patch) => {
    // Interfere: simulate worker transitioning it to executing in the background
    await originalUpdateIfStatus(id, expected, { status: "executing" });
    // Now the conditional update with expectedStatus 'queued' will fail (race lost)
    return originalUpdateIfStatus(id, expected, patch);
  };

  const res = await queue.cancel(execution.id);
  assert.equal(res.status, "conflict");
});

test("ExecutionQueue.retry: explicitly rejects cancelled execution", async () => {
  const store = new InMemoryExecutionStore();
  const queue = new ExecutionQueue(store, async (rec) => ({ record: rec, success: true }));
  const execution = makeExecution({ status: "cancelled", attempt: 1, error: "cancelled by user" });
  await store.record(execution);

  const res = await queue.retry(execution.id, 3);
  assert.equal(res.status, "invalid_state");
  const stored = await store.get(execution.id);
  assert.equal(stored?.status, "cancelled");
});
