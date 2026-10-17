import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/index.js";
import { DevAuthProvider } from "@4evergent/shared";
import { InMemoryExecutionStore, InMemoryActivityStore, InMemoryApprovalStore, InMemoryScheduleStore, InMemoryAgentStore } from "@4evergent/database";
import type { ExecutionRecord } from "@4evergent/database";

import { ExecutionQueue } from "../src/execution-queue.js";

function makeExecution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    ownerId: "owner-a",
    agentId: "agent-a",
    approvalId: null,
    activityId: null,
    intent: { type: "payment", asset: "XLM", destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", amount: "10", reason: "test" },
    status: "failed",
    policyDecision: null,
    simulationResult: null,
    txHash: null,
    error: "Network timeout",
    attempt: 1,
    nextRetryAt: null,
    startedAt: null,
    completedAt: null,
    errorClass: "transient",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function startServer(customQueue?: ExecutionQueue, customExecutionStore?: InMemoryExecutionStore) {
  const executionStore = customExecutionStore ?? new InMemoryExecutionStore();
  const activityStore = new InMemoryActivityStore();
  const approvalStore = new InMemoryApprovalStore();
  const scheduleStore = new InMemoryScheduleStore();
  const agentStore = new InMemoryAgentStore();

  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: {
      getAccountId: () => "GTEST",
      getNetworkPassphrase: () => "Test SDF Network ; September 2015",
      sign: async (tx: any) => tx,
    },
    activityStore,
    approvalStore,
    scheduleStore,
    executionStore,
    agentStore,
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
    executionQueue: customQueue ? { enabled: true, instance: customQueue } : { enabled: true, intervalMs: 60000 },
  });

  await server.listen(0);
  const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;
  return { baseUrl, close: () => server.close(), executionStore, activityStore };
}

test("POST /executions/:id/retry — failed → queued", async () => {
  const { baseUrl, close, executionStore } = await startServer();
  try {
    const execution = makeExecution({ status: "failed", attempt: 1, errorClass: "transient" });
    await executionStore.record(execution);

    const res = await fetch(`${baseUrl}/executions/${execution.id}/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.execution.status, "queued");
    assert.equal(body.execution.error, null);
    assert.equal(body.execution.nextRetryAt, null);
  } finally {
    await close();
  }
});

test("POST /executions/:id/retry — dead_letter → queued", async () => {
  const { baseUrl, close, executionStore } = await startServer();
  try {
    // dead_letter with attempt < maxRetries (dead_letter can occur via permanent failure without exhausting retries)
    const execution = makeExecution({ status: "dead_letter", attempt: 2, errorClass: "permanent" });
    await executionStore.record(execution);

    const res = await fetch(`${baseUrl}/executions/${execution.id}/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.execution.status, "queued");
  } finally {
    await close();
  }
});

test("POST /executions/:id/retry — submitted → 409", async () => {
  const { baseUrl, close, executionStore } = await startServer();
  try {
    const execution = makeExecution({ status: "submitted", txHash: "tx-123" });
    await executionStore.record(execution);

    const res = await fetch(`${baseUrl}/executions/${execution.id}/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 409);
  } finally {
    await close();
  }
});

test("POST /executions/:id/retry — confirmed → 409", async () => {
  const { baseUrl, close, executionStore } = await startServer();
  try {
    const execution = makeExecution({ status: "confirmed", txHash: "tx-123" });
    await executionStore.record(execution);

    const res = await fetch(`${baseUrl}/executions/${execution.id}/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 409);
  } finally {
    await close();
  }
});

test("POST /executions/:id/retry — max attempts reached → 409", async () => {
  const { baseUrl, close, executionStore } = await startServer();
  try {
    const execution = makeExecution({ status: "failed", attempt: 3, errorClass: "transient" });
    await executionStore.record(execution);

    const res = await fetch(`${baseUrl}/executions/${execution.id}/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /max retry attempts/);
  } finally {
    await close();
  }
});

test("POST /executions/:id/retry — not found → 404", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/executions/nonexistent/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test("POST /executions/:id/cancel — queued → cancelled", async () => {
  const { baseUrl, close, executionStore } = await startServer();
  try {
    const execution = makeExecution({ status: "queued", attempt: 0 });
    await executionStore.record(execution);

    const res = await fetch(`${baseUrl}/executions/${execution.id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.execution.status, "cancelled");
    assert.equal(body.execution.error, "cancelled by user");
  } finally {
    await close();
  }
});

test("POST /executions/:id/cancel — rejects executing record when no local in-flight entry exists", async () => {
  const { baseUrl, close, executionStore } = await startServer();
  try {
    const execution = makeExecution({ status: "executing", attempt: 1 });
    await executionStore.record(execution);

    const res = await fetch(`${baseUrl}/executions/${execution.id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /not actively running on this worker/i);
    const stored = await executionStore.get(execution.id);
    assert.equal(stored?.status, "executing", "status must remain executing and not falsely imply cancellation");
  } finally {
    await close();
  }
});

test("POST /executions/:id/cancel — cancels running in-flight execution and prevents transaction submission", async () => {
  const executionStore = new InMemoryExecutionStore();
  let txSubmitted = false;
  let resolveRunning: () => void;
  const runningPromise = new Promise<void>((r) => {
    resolveRunning = r;
  });

  const customQueue = new ExecutionQueue(executionStore, async (rec, ctx) => {
    resolveRunning();
    await new Promise((r) => setTimeout(r, 60));

    if (ctx?.signal.aborted) {
      const err = new Error("Execution was cancelled");
      err.name = "AbortError";
      throw err;
    }
    await ctx?.onBeforeSubmit?.();
    if (ctx?.signal.aborted) {
      const err = new Error("Execution was cancelled");
      err.name = "AbortError";
      throw err;
    }

    txSubmitted = true;
    ctx?.onSubmitted?.("tx-999");
    return { record: rec, success: true, status: "submitted", txHash: "tx-999" };
  });

  const { baseUrl, close } = await startServer(customQueue, executionStore);
  try {
    const execution = makeExecution({ status: "queued", nextRetryAt: "2026-01-01T00:00:00Z" });
    await executionStore.record(execution);

    const processPromise = customQueue.processDue("2026-01-01T00:00:01Z");
    await runningPromise;

    // Issue cancel while pipeline is in progress
    const res = await fetch(`${baseUrl}/executions/${execution.id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.execution.status, "cancelled");
    assert.equal(body.execution.error, "cancelled by user");

    await processPromise;

    // Transaction submission must NOT have happened
    assert.equal(txSubmitted, false, "transaction submission must not happen after cancellation");

    const final = await executionStore.get(execution.id);
    assert.equal(final?.status, "cancelled");
    assert.equal(final?.txHash, null);
  } finally {
    await close();
  }
});

test("POST /executions/:id/cancel — rejects cancellation once in-flight execution is in submitting phase", async () => {
  const executionStore = new InMemoryExecutionStore();
  let resolveSubmitting: () => void;
  const submittingPromise = new Promise<void>((r) => {
    resolveSubmitting = r;
  });
  let resolveFinishSubmit: () => void;
  const finishSubmitPromise = new Promise<void>((r) => {
    resolveFinishSubmit = r;
  });

  const customQueue = new ExecutionQueue(executionStore, async (rec, ctx) => {
    await ctx?.onBeforeSubmit?.();
    resolveSubmitting();

    await finishSubmitPromise;
    ctx?.onSubmitted?.("tx-submitted-888");
    return { record: rec, success: true, status: "submitted", txHash: "tx-submitted-888" };
  });

  const { baseUrl, close } = await startServer(customQueue, executionStore);
  try {
    const execution = makeExecution({ status: "queued", nextRetryAt: "2026-01-01T00:00:00Z" });
    await executionStore.record(execution);

    const processPromise = customQueue.processDue("2026-01-01T00:00:01Z");
    await submittingPromise;

    // Cancel while in submitting phase
    const res = await fetch(`${baseUrl}/executions/${execution.id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /cannot cancel execution/);

    resolveFinishSubmit();
    await processPromise;

    const final = await executionStore.get(execution.id);
    assert.equal(final?.status, "submitted");
    assert.equal(final?.txHash, "tx-submitted-888");
  } finally {
    await close();
  }
});

test("POST /executions/:id/cancel — submitted → 409", async () => {
  const { baseUrl, close, executionStore } = await startServer();
  try {
    const execution = makeExecution({ status: "submitted", txHash: "tx-123" });
    await executionStore.record(execution);

    const res = await fetch(`${baseUrl}/executions/${execution.id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 409);
  } finally {
    await close();
  }
});

test("POST /executions/:id/cancel — confirmed → 409", async () => {
  const { baseUrl, close, executionStore } = await startServer();
  try {
    const execution = makeExecution({ status: "confirmed", txHash: "tx-123" });
    await executionStore.record(execution);

    const res = await fetch(`${baseUrl}/executions/${execution.id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 409);
  } finally {
    await close();
  }
});

test("POST /executions/:id/cancel — not found → 404", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/executions/nonexistent/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test("POST /executions/:id/retry — cancelled execution rejected with 409", async () => {
  const { baseUrl, close, executionStore } = await startServer();
  try {
    const execution = makeExecution({ status: "cancelled", attempt: 1, error: "cancelled by user" });
    await executionStore.record(execution);

    const res = await fetch(`${baseUrl}/executions/${execution.id}/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /cannot retry execution in status 'cancelled'/);
  } finally {
    await close();
  }
});

test("overview counters and queue status after cancellation", async () => {
  const { baseUrl, close, executionStore } = await startServer();
  try {
    const execution = makeExecution({ status: "queued", attempt: 0 });
    await executionStore.record(execution);

    // Cancel execution
    const cancelRes = await fetch(`${baseUrl}/executions/${execution.id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(cancelRes.status, 200);

    // GET /overview/attention: deadLetterExecutions must NOT count cancelled executions
    const attentionRes = await fetch(`${baseUrl}/overview/attention`);
    assert.equal(attentionRes.status, 200);
    const attentionBody = await attentionRes.json();
    assert.equal(attentionBody.deadLetterExecutions, 0);
    assert.equal(attentionBody.failedExecutions, 0);
    assert.equal(attentionBody.retryingExecutions, 0);
    assert.equal(attentionBody.stuckExecutions, 0);

    // GET /agent-queue: byStatus has cancelled: 1 and dead_letter: undefined/0
    const queueRes = await fetch(`${baseUrl}/agent-queue`);
    assert.equal(queueRes.status, 200);
    const queueBody = await queueRes.json();
    assert.equal(queueBody.byStatus.cancelled, 1);
    assert.equal(queueBody.byStatus.dead_letter ?? 0, 0);
  } finally {
    await close();
  }
});

test("migration note: historical dead_letter records with error 'cancelled by user' are still counted as deadLetterExecutions", async () => {
  const { baseUrl, close, executionStore } = await startServer();
  try {
    const historical = makeExecution({
      status: "dead_letter",
      error: "cancelled by user",
      completedAt: "2025-12-01T00:00:00.000Z",
    });
    await executionStore.record(historical);

    const res = await fetch(`${baseUrl}/overview/attention`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.deadLetterExecutions, 1);
  } finally {
    await close();
  }
});
