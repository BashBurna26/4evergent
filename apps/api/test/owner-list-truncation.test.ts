import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import type { Signer } from "@4evergent/stellar";
import type { AddressInfo } from "node:net";
import { createApiServer } from "../src/index.js";
import { DevAuthProvider } from "@4evergent/shared";
import { createApproval } from "@4evergent/database";
import type { ExecutionRecord, ExecutionStatus } from "@4evergent/database";

// Offline test: in-process HTTP server + in-memory stores. No network access.
// Regression tests for issue #61 — owner-scoped endpoints must not silently
// truncate at 200 rows.

class MockSigner implements Signer {
  private id: string;
  constructor(id: string) {
    this.id = id.startsWith("G") ? id : `G${id.padEnd(55, "A").slice(0, 55)}`;
  }
  getAccountId(): string { return this.id; }
  getNetworkPassphrase(): string { return "Test SDF Network ; September 2015"; }
  async sign(transaction: any): Promise<any> {
    transaction.signatures = [{ hint: Buffer.from("mock"), signature: Buffer.from("sig") }];
    return transaction;
  }
}

const OWNER = "test"; // DevAuthProvider defaultOwnerId below
const OTHER_OWNER = "someone-else";

async function startServer(opts?: { executionQueue?: boolean }) {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner("test-agent"),
    authProvider: new DevAuthProvider({ defaultOwnerId: OWNER }),
    // Long interval so the worker never ticks during the test.
    executionQueue: opts?.executionQueue ? { enabled: true, intervalMs: 3_600_000 } : undefined,
  });

  return new Promise<{
    baseUrl: string;
    close: () => Promise<void>;
    approvals: typeof server.approvals;
    executionStore: typeof server.executionStore;
  }>((resolve) => {
    const http = server.server.listen(0, "127.0.0.1", () => {
      const addr = http.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
        approvals: server.approvals,
        executionStore: server.executionStore,
      });
    });
  });
}

async function get(baseUrl: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
}

const destination = Keypair.random().publicKey();
const intent = {
  type: "payment" as const,
  asset: "XLM",
  destination,
  amount: "1",
  reason: "seed",
};
const decision = { result: "requires_approval", reason: "seed", rule: "seed", intent } as any;

async function seedApprovals(
  approvals: { record: (r: any) => Promise<void> },
  ownerId: string,
  count: number,
  status: string = "pending_approval",
) {
  for (let i = 0; i < count; i++) {
    const rec = createApproval(crypto.randomUUID(), "test-agent", ownerId, intent, decision);
    rec.status = status as any;
    await approvals.record(rec);
  }
}

async function seedExecutions(
  store: { record: (r: ExecutionRecord) => Promise<void> },
  ownerId: string,
  count: number,
  status: ExecutionStatus,
) {
  const now = new Date().toISOString();
  for (let i = 0; i < count; i++) {
    await store.record({
      id: crypto.randomUUID(),
      ownerId,
      agentId: "test-agent",
      approvalId: null,
      activityId: null,
      intent,
      status,
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
    } as ExecutionRecord);
  }
}

test("overview/attention: pendingApprovals is exact when owner has more than 200 approvals", async () => {
  const { baseUrl, close, approvals } = await startServer();
  try {
    await seedApprovals(approvals, OWNER, 250);
    await seedApprovals(approvals, OWNER, 5, "approved");
    await seedApprovals(approvals, OTHER_OWNER, 3);

    const res = await get(baseUrl, "/overview/attention");
    assert.equal(res.status, 200);
    assert.equal(res.body.pendingApprovals, 250, "must not be capped at 200");
  } finally {
    await close();
  }
});

test("approvals: default page reports truncated=true and the true total", async () => {
  const { baseUrl, close, approvals } = await startServer();
  try {
    await seedApprovals(approvals, OWNER, 250);
    await seedApprovals(approvals, OTHER_OWNER, 10);

    const res = await get(baseUrl, "/approvals?status=pending_approval");
    assert.equal(res.status, 200);
    assert.equal(res.body.approvals.length, 50);
    assert.equal(res.body.total, 250);
    assert.equal(res.body.truncated, true);
    assert.equal(res.body.hasMore, true);
  } finally {
    await close();
  }
});

test("approvals: limit=200 returns 200 rows and still signals truncation", async () => {
  const { baseUrl, close, approvals } = await startServer();
  try {
    await seedApprovals(approvals, OWNER, 250);

    const res = await get(baseUrl, "/approvals?status=pending_approval&limit=200");
    assert.equal(res.body.approvals.length, 200);
    assert.equal(res.body.total, 250);
    assert.equal(res.body.truncated, true);
    assert.equal(res.body.hasMore, true);
  } finally {
    await close();
  }
});

test("approvals: last page reports truncated=false", async () => {
  const { baseUrl, close, approvals } = await startServer();
  try {
    await seedApprovals(approvals, OWNER, 250);

    const res = await get(baseUrl, "/approvals?status=pending_approval&limit=200&offset=200");
    assert.equal(res.body.approvals.length, 50);
    assert.equal(res.body.total, 250);
    assert.equal(res.body.truncated, false);
    assert.equal(res.body.hasMore, false);
  } finally {
    await close();
  }
});

test("approvals: limit above the maximum is clamped to 200", async () => {
  const { baseUrl, close, approvals } = await startServer();
  try {
    await seedApprovals(approvals, OWNER, 250);

    const res = await get(baseUrl, "/approvals?status=pending_approval&limit=500");
    assert.equal(res.body.approvals.length, 200);
    assert.equal(res.body.truncated, true);
  } finally {
    await close();
  }
});

test("approvals: small owner is not truncated", async () => {
  const { baseUrl, close, approvals } = await startServer();
  try {
    await seedApprovals(approvals, OWNER, 3);

    const res = await get(baseUrl, "/approvals");
    assert.equal(res.body.approvals.length, 3);
    assert.equal(res.body.total, 3);
    assert.equal(res.body.truncated, false);
    assert.equal(res.body.hasMore, false);
  } finally {
    await close();
  }
});

test("agent-queue: byStatus counts are exact when owner has more than 200 executions", async () => {
  const { baseUrl, close, executionStore } = await startServer({ executionQueue: true });
  try {
    // Statuses the worker never picks up (not queued/failed/executing).
    await seedExecutions(executionStore, OWNER, 230, "confirmed");
    await seedExecutions(executionStore, OWNER, 30, "dead_letter");
    await seedExecutions(executionStore, OTHER_OWNER, 7, "confirmed");

    const res = await get(baseUrl, "/agent-queue");
    assert.equal(res.status, 200);
    assert.equal(res.body.byStatus.confirmed, 230);
    assert.equal(res.body.byStatus.dead_letter, 30);
    const sum = Object.values(res.body.byStatus as Record<string, number>).reduce((a, b) => a + b, 0);
    assert.equal(sum, 260, "no rows silently dropped");
  } finally {
    await close();
  }
});
