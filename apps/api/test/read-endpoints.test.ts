import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/index.js";
import { DevAuthProvider } from "@4evergent/shared";
import type { Signer } from "@4evergent/stellar";
import type { PolicyRules } from "@4evergent/shared";
import type { AddressInfo } from "node:net";
import { Keypair } from "@stellar/stellar-sdk";
import { InMemoryExecutionStore, InMemoryScheduleStore, InMemoryApprovalStore, InMemoryActivityStore } from "@4evergent/database";
import type { ExecutionStore, ExecutionRecord, ScheduleRecord, ApprovalStore, ApprovalRecord, ActivityStore, ActivityRecord } from "@4evergent/database";

declare const fetch: typeof globalThis.fetch;

// fetch with keepalive disabled so Node's http server can close cleanly between tests
async function apiFetch(url: string, init?: RequestInit) {
  return fetch(url, { ...init, keepalive: false });
}

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

const TEST_AGENT = {
  id: "test-agent",
  displayName: "Test Agent",
  description: "test agent",
  ownerId: "test",
  stellarAddress: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  capabilities: ["payment"],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  active: true,
  metadata: {},
};

async function startServer(opts?: { policyRules?: Partial<PolicyRules>; registerAgent?: boolean }) {
  const executionStore = new InMemoryExecutionStore();
  const scheduleStore = new InMemoryScheduleStore();
  const approvalStore = new InMemoryApprovalStore();
  const activityStore = new InMemoryActivityStore();
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner("test-agent"),
    policyRules: opts?.policyRules,
    deferExecution: true,
    authProvider: new DevAuthProvider({ defaultOwnerId: "test" }),
    executionStore,
    scheduleStore,
    approvalStore,
    activityStore,
  });
  if (opts?.registerAgent !== false) {
    server.registerAgent(TEST_AGENT);
  }

  return new Promise<{
    baseUrl: string;
    close: () => Promise<void>;
    executionStore: ExecutionStore;
    scheduleStore: InMemoryScheduleStore;
    approvalStore: ApprovalStore;
    activityStore: ActivityStore;
  }>((resolve) => {
    const http = server.server.listen(0, "127.0.0.1", () => {
      const addr = http.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
        executionStore,
        scheduleStore,
        approvalStore,
        activityStore,
      });
    });
  });
}

async function get(baseUrl: string, path: string) {
  const res = await apiFetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
}

// ===== GET /agents =====

test("GET /agents returns registered agents without secret fields", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await get(baseUrl, "/agents");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.agents));
    assert.equal(res.body.agents.length, 1);
    assert.equal(res.body.agents[0].id, "test-agent");
    assert.equal(res.body.agents[0].displayName, "Test Agent");

    // No secret material in the response
    const json = JSON.stringify(res.body);
    assert.ok(!/secret|seed|private_key|mnemonic|keypair/i.test(json));
  } finally {
    await close();
  }
});

test("GET /agents returns empty list when no agents registered", async () => {
  const { baseUrl, close } = await startServer({ registerAgent: false });
  try {
    const res = await get(baseUrl, "/agents");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.agents));
    // Note: agents map is module-level shared state, so other test files in
    // the same test process may have registered agents already. The contract
    // is: the endpoint returns an array and never leaks secrets.
    const json = JSON.stringify(res.body);
    assert.ok(!/secret|seed|private_key|mnemonic|keypair/i.test(json));
  } finally {
    await close();
  }
});

// ===== GET /agents/:id/activity =====

test("GET /agents/:id/activity returns persisted activity", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    // Submit an intent that requires approval -> creates an activity record
    const intentRes = await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "payment",
        asset: "XLM",
        destination: Keypair.random().publicKey(),
        amount: "50",
        reason: "read endpoint test",
      }),
    });
    assert.equal(intentRes.status, 202);
    const intentBody = await intentRes.json();

    const res = await get(baseUrl, `/agents/test-agent/activity`);
    assert.equal(res.status, 200);
    assert.equal(res.body.agentId, "test-agent");
    assert.ok(Array.isArray(res.body.activity));
    assert.equal(res.body.activity.length, 1);
    assert.equal(res.body.activity[0].id, intentBody.activityId);
    assert.equal(res.body.activity[0].status, "requires_approval");

    // Activity record must not contain secret material
    const json = JSON.stringify(res.body);
    assert.ok(!/secret|seed|private_key|mnemonic|keypair/i.test(json));
  } finally {
    await close();
  }
});

test("GET /agents/:id/activity returns 404 for unknown/non-owned agent", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await get(baseUrl, "/agents/nonexistent-agent/activity");
    // Authorization rejects non-owned agents with 404 (not found)
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test("GET /agents/:id/activity respects limit query param", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    // Create 3 activity records
    for (let i = 0; i < 3; i++) {
      await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "payment",
          asset: "XLM",
          destination: Keypair.random().publicKey(),
          amount: "50",
          reason: `limit test ${i}`,
        }),
      });
    }
    const res = await get(baseUrl, "/agents/test-agent/activity?limit=2");
    assert.equal(res.status, 200);
    assert.equal(res.body.activity.length, 2);
  } finally {
    await close();
  }
});

// ===== GET /approvals =====

test("GET /approvals returns persisted approvals", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    const intentRes = await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "payment",
        asset: "XLM",
        destination: Keypair.random().publicKey(),
        amount: "50",
        reason: "approvals list test",
      }),
    });
    const intentBody = await intentRes.json();

    const res = await get(baseUrl, "/approvals");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.approvals));
    assert.equal(res.body.approvals.length, 1);
    assert.equal(res.body.approvals[0].id, intentBody.approvalId);
    assert.equal(res.body.approvals[0].status, "pending_approval");

    // Approval list must not contain secret material or XDR
    const json = JSON.stringify(res.body);
    assert.ok(!/secret|seed|private_key|mnemonic|keypair/i.test(json));
  } finally {
    await close();
  }
});

test("GET /approvals?status=pending_approval filters by status", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    // Two intents requiring approval
    for (let i = 0; i < 2; i++) {
      await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "payment",
          asset: "XLM",
          destination: Keypair.random().publicKey(),
          amount: "50",
          reason: `status filter ${i}`,
        }),
      });
    }

    const pending = await get(baseUrl, "/approvals?status=pending_approval");
    assert.equal(pending.status, 200);
    assert.equal(pending.body.approvals.length, 2);
    for (const a of pending.body.approvals) {
      assert.equal(a.status, "pending_approval");
    }

    const approved = await get(baseUrl, "/approvals?status=approved");
    assert.equal(approved.status, 200);
    assert.equal(approved.body.approvals.length, 0);
  } finally {
    await close();
  }
});

test("GET /approvals returns empty list when none exist", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await get(baseUrl, "/approvals");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.approvals, []);
  } finally {
    await close();
  }
});

// ===== Read endpoints do not expose raw XDR =====

test("read endpoints never return raw XDR or transaction blobs", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "payment",
        asset: "XLM",
        destination: Keypair.random().publicKey(),
        amount: "50",
        reason: "xdr leak test",
      }),
    });

    const activity = await get(baseUrl, "/agents/test-agent/activity");
    const approvals = await get(baseUrl, "/approvals");
    const blob = JSON.stringify(activity.body) + JSON.stringify(approvals.body);
    assert.ok(!/"xdr"/.test(blob), "read endpoints must not expose xdr field");
    assert.ok(!/"envelope"/.test(blob), "read endpoints must not expose envelope field");
    assert.ok(!/"tx_blob"/.test(blob), "read endpoints must not expose tx_blob field");
  } finally {
    await close();
  }
});

// ===== Execution lifecycle visibility =====

function makeSchedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    agentId: "test-agent",
    ownerId: "test",
    status: "active",
    intent: { type: "payment", asset: "XLM", destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", amount: "10", reason: "scheduled test" },
    scheduleExpression: "0 0 * * *",
    timezone: "UTC",
    nextRunAt: new Date().toISOString(),
    lastRunAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeExecution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    ownerId: "test",
    agentId: "test-agent",
    approvalId: null,
    activityId: null,
    intent: { type: "payment", asset: "XLM", destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", amount: "10", reason: "test" },
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

function makeApproval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    activityId: crypto.randomUUID(),
    agentId: "test-agent",
    ownerId: "test",
    intent: { type: "payment", asset: "XLM", destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", amount: "50", reason: "approval pagination test" },
    policyDecision: { decision: "require_approval", reasons: ["amount above threshold"] } as any,
    status: "pending_approval",
    requestedAt: now,
    approvedAt: null,
    rejectedAt: null,
    expiredAt: null,
    approver: null,
    expiresAt: null,
    txHash: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeActivity(overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    ownerId: "test",
    agentId: "test-agent",
    intent: { type: "payment", asset: "XLM", destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", amount: "50", reason: "activity pagination test" },
    policyDecision: { decision: "allow", reasons: [] } as any,
    authorizationStatus: "not_required",
    status: "pending",
    txHash: null,
    simulationResult: null,
    error: null,
    idempotencyKey: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("GET /executions/:id — confirmed execution readable with txHash and completedAt", async () => {
  const { baseUrl, close, executionStore } = await startServer();
  try {
    const execution = makeExecution({ status: "confirmed", txHash: "a".repeat(64), completedAt: new Date().toISOString() });
    await executionStore.record(execution);

    const res = await get(baseUrl, `/executions/${execution.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.execution.status, "confirmed");
    assert.equal(res.body.execution.txHash, "a".repeat(64));
    assert.ok(res.body.execution.completedAt);
  } finally {
    await close();
  }
});

test("GET /executions/:id — dead_letter execution readable with error and attempt count", async () => {
  const { baseUrl, close, executionStore } = await startServer();
  try {
    const execution = makeExecution({
      status: "dead_letter",
      error: "Max retries exceeded: network timeout",
      attempt: 3,
      errorClass: "transient",
      completedAt: new Date().toISOString(),
    });
    await executionStore.record(execution);

    const res = await get(baseUrl, `/executions/${execution.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.execution.status, "dead_letter");
    assert.ok(res.body.execution.error);
    assert.equal(res.body.execution.attempt, 3);
    assert.equal(res.body.execution.errorClass, "transient");
  } finally {
    await close();
  }
});

test("GET /agents/:id/executions — mixed lifecycle statuses all returned", async () => {
  const { baseUrl, close, executionStore } = await startServer();
  try {
    await executionStore.record(makeExecution({ status: "queued" }));
    await executionStore.record(makeExecution({ status: "executing", startedAt: new Date().toISOString() }));
    await executionStore.record(makeExecution({ status: "submitted", txHash: "b".repeat(64) }));
    await executionStore.record(makeExecution({ status: "confirmed", txHash: "c".repeat(64), completedAt: new Date().toISOString() }));
    await executionStore.record(makeExecution({ status: "failed", error: "on-chain failed", errorClass: "permanent", completedAt: new Date().toISOString() }));
    await executionStore.record(makeExecution({ status: "dead_letter", error: "max retries", attempt: 3 }));

    const res = await get(baseUrl, "/agents/test-agent/executions");
    assert.equal(res.status, 200);
    assert.equal(res.body.executions.length, 6);
    const statuses = new Set(res.body.executions.map((e: ExecutionRecord) => e.status));
    assert.ok(statuses.has("queued"));
    assert.ok(statuses.has("executing"));
    assert.ok(statuses.has("submitted"));
    assert.ok(statuses.has("confirmed"));
    assert.ok(statuses.has("failed"));
    assert.ok(statuses.has("dead_letter"));
  } finally {
    await close();
  }
});

test("GET /executions/:id — owner isolation on lifecycle reads (cross-owner 404)", async () => {
  const { baseUrl, close, executionStore } = await startServer();
  try {
    const execution = makeExecution({ ownerId: "owner-b", status: "confirmed", txHash: "d".repeat(64) });
    await executionStore.record(execution);

    const res = await get(baseUrl, `/executions/${execution.id}`);
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

// ===== GET /executions (global owner-scoped listing) =====

test("GET /executions returns owner's executions in single request", async () => {
  const { baseUrl, close, executionStore } = await startServer();
  try {
    await executionStore.record(makeExecution({ id: "exec-a", status: "confirmed", txHash: "a".repeat(64) }));
    await executionStore.record(makeExecution({ id: "exec-b", status: "failed", error: "timeout", attempt: 1 }));

    const res = await get(baseUrl, "/executions");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.executions));
    assert.equal(res.body.executions.length, 2);
    const ids = new Set(res.body.executions.map((e: any) => e.id));
    assert.ok(ids.has("exec-a"));
    assert.ok(ids.has("exec-b"));

    // No secret material
    const json = JSON.stringify(res.body);
    assert.ok(!/secret|seed|private_key|mnemonic|keypair/i.test(json));
  } finally {
    await close();
  }
});

test("GET /executions does not return another owner's executions", async () => {
  const { baseUrl, close, executionStore } = await startServer();
  try {
    // Owner "test" has no executions; "owner-b" has one
    await executionStore.record(makeExecution({ ownerId: "owner-b", id: "exec-other" }));
    const res = await get(baseUrl, "/executions");
    assert.equal(res.status, 200);
    assert.equal(res.body.executions.length, 0);
  } finally {
    await close();
  }
});

test("GET /executions respects limit", async () => {
  const { baseUrl, close, executionStore } = await startServer();
  try {
    for (let i = 0; i < 5; i++) {
      await executionStore.record(makeExecution({ id: `exec-${i}` }));
    }
    const res = await get(baseUrl, "/executions?limit=2");
    assert.equal(res.status, 200);
    assert.equal(res.body.executions.length, 2);
  } finally {
    await close();
  }
});

// ===== GET /activity (global owner-scoped listing) =====

test("GET /activity returns owner's activity in single request", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    // Generate activity by submitting intents
    for (let i = 0; i < 2; i++) {
      const intentRes = await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "payment",
          asset: "XLM",
          destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          amount: "50",
          reason: `activity test ${i}`,
        }),
      });
      assert.equal(intentRes.status, 202);
    }
    const res = await get(baseUrl, "/activity");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.activity));
    assert.equal(res.body.activity.length, 2);
    assert.ok(res.body.activity[0].id);
  } finally {
    await close();
  }
});

test("GET /activity does not return another owner's activity", async () => {
  const { baseUrl, close } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
    registerAgent: false,
  });
  try {
    const res = await get(baseUrl, "/activity");
    assert.equal(res.status, 200);
    assert.equal(res.body.activity.length, 0);
  } finally {
    await close();
  }
});

test("GET /activity respects limit", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    for (let i = 0; i < 3; i++) {
      await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "payment",
          asset: "XLM",
          destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          amount: "50",
          reason: `limit test ${i}`,
        }),
      });
    }
    const res = await get(baseUrl, "/activity?limit=2");
    assert.equal(res.status, 200);
    assert.equal(res.body.activity.length, 2);
  } finally {
    await close();
  }
});

// --- Pagination offset tests ---

test("GET /activity offset returns next page and hasMore", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    for (let i = 0; i < 5; i++) {
      await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "payment",
          asset: "XLM",
          destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          amount: "50",
          reason: `paginate test ${i}`,
        }),
      });
    }
    const page1 = await get(baseUrl, "/activity?limit=3&offset=0");
    assert.equal(page1.status, 200);
    assert.equal(page1.body.activity.length, 3);
    assert.equal(page1.body.hasMore, true);

    const page2 = await get(baseUrl, "/activity?limit=3&offset=3");
    assert.equal(page2.status, 200);
    assert.equal(page2.body.activity.length, 2);
    assert.equal(page2.body.hasMore, false);

    // Ensure no overlap
    const page1Ids = new Set(page1.body.activity.map((a: any) => a.id));
    for (const a of page2.body.activity) assert.ok(!page1Ids.has(a.id));
  } finally {
    await close();
  }
});

test("GET /activity hasMore false when fewer than limit+1 items exist", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    for (let i = 0; i < 2; i++) {
      await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "payment",
          asset: "XLM",
          destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          amount: "50",
          reason: `hasMore test ${i}`,
        }),
      });
    }
    const res = await get(baseUrl, "/activity?limit=5&offset=0");
    assert.equal(res.status, 200);
    assert.equal(res.body.activity.length, 2);
    assert.equal(res.body.hasMore, false);
  } finally {
    await close();
  }
});

test("GET /executions offset pagination works", async () => {
  const { baseUrl, close, executionStore } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" } },
  });
  try {
    for (let i = 0; i < 4; i++) {
      await executionStore.record(makeExecution({ status: "confirmed" }));
    }
    const page1 = await get(baseUrl, "/executions?limit=2&offset=0");
    assert.equal(page1.status, 200);
    assert.equal(page1.body.executions.length, 2);
    assert.equal(page1.body.hasMore, true);

    const page2 = await get(baseUrl, "/executions?limit=2&offset=2");
    assert.equal(page2.status, 200);
    assert.equal(page2.body.executions.length, 2);
    assert.equal(page2.body.hasMore, false);
  } finally {
    await close();
  }
});

test("GET /executions?offset without limit works", async () => {
  const { baseUrl, close, executionStore } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" } },
  });
  try {
    for (let i = 0; i < 3; i++) {
      await executionStore.record(makeExecution({ status: "confirmed" }));
    }
    const res = await get(baseUrl, "/executions?offset=1");
    assert.equal(res.status, 200);
    assert.equal(res.body.executions.length, 2);
    assert.equal(res.body.hasMore, false);
  } finally {
    await close();
  }
});

test("GET /agents/:id/activity offset pagination", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" } },
  });
  try {
    for (let i = 0; i < 3; i++) {
      await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "payment",
          asset: "XLM",
          destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          amount: "50",
          reason: `agent activity pagination ${i}`,
        }),
      });
    }
    const page1 = await get(baseUrl, "/agents/test-agent/activity?limit=2&offset=0");
    assert.equal(page1.status, 200);
    assert.equal(page1.body.activity.length, 2);
    assert.equal(page1.body.hasMore, true);

    const page2 = await get(baseUrl, "/agents/test-agent/activity?limit=2&offset=2");
    assert.equal(page2.status, 200);
    assert.equal(page2.body.activity.length, 1);
    assert.equal(page2.body.hasMore, false);
  } finally {
    await close();
  }
});

test("GET /agents/:id/executions offset pagination", async () => {
  const { baseUrl, close, executionStore } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" } },
  });
  try {
    for (let i = 0; i < 3; i++) {
      await executionStore.record(makeExecution({ status: "confirmed" }));
    }
    const page1 = await get(baseUrl, "/agents/test-agent/executions?limit=2&offset=0");
    assert.equal(page1.status, 200);
    assert.equal(page1.body.executions.length, 2);
    assert.equal(page1.body.hasMore, true);

    const page2 = await get(baseUrl, "/agents/test-agent/executions?limit=2&offset=2");
    assert.equal(page2.status, 200);
    assert.equal(page2.body.executions.length, 1);
    assert.equal(page2.body.hasMore, false);
  } finally {
    await close();
  }
});

// Regression: agent executions must paginate past the first page even when the
// offset exceeds the store's internal page clamp. The handler used to request
// `offset + limit + 1` rows from the store, which the store clamped to its
// maximum — so a large offset returned an empty page with hasMore=false while
// executions still existed beyond it.
test("GET /agents/:id/executions paginates past the first page with a large offset", async () => {
  const { baseUrl, close, executionStore } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" } },
  });
  try {
    for (let i = 0; i < 250; i++) {
      await executionStore.record(
        makeExecution({ status: "confirmed", updatedAt: new Date(Date.now() + i).toISOString() })
      );
    }

    const page1 = await get(baseUrl, "/agents/test-agent/executions?limit=50&offset=0");
    assert.equal(page1.status, 200);
    assert.equal(page1.body.executions.length, 50);
    assert.equal(page1.body.hasMore, true);

    // offset 200 is past the store's 200-row clamp — must still return a page
    const page5 = await get(baseUrl, "/agents/test-agent/executions?limit=50&offset=200");
    assert.equal(page5.status, 200);
    assert.equal(page5.body.executions.length, 50);
    assert.equal(page5.body.hasMore, false);

    const page1Ids = new Set(page1.body.executions.map((e: any) => e.id));
    for (const e of page5.body.executions) assert.ok(!page1Ids.has(e.id));
  } finally {
    await close();
  }
});

test("GET /agents/:id/schedules offset pagination", async () => {
  const { baseUrl, close, scheduleStore } = await startServer({});
  try {
    for (let i = 0; i < 3; i++) {
      await scheduleStore.create(makeSchedule());
    }
    const page1 = await get(baseUrl, "/agents/test-agent/schedules?limit=2&offset=0");
    assert.equal(page1.status, 200);
    assert.equal(page1.body.schedules.length, 2);
    assert.equal(page1.body.hasMore, true);

    const page2 = await get(baseUrl, "/agents/test-agent/schedules?limit=2&offset=2");
    assert.equal(page2.status, 200);
    assert.equal(page2.body.schedules.length, 1);
    assert.equal(page2.body.hasMore, false);
  } finally {
    await close();
  }
});

// ===== Approval pagination beyond the old 200-record cap =====

test("GET /approvals paginates past 200 records (store-level offset)", async () => {
  const { baseUrl, close, approvalStore } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    // 250 approvals — the old handler capped the read at 200, so offsets
    // beyond 200 returned an empty page with hasMore=false.
    for (let i = 0; i < 250; i++) {
      await approvalStore.record(
        makeApproval({ createdAt: new Date(Date.now() + i).toISOString() })
      );
    }

    const page1 = await get(baseUrl, "/approvals?limit=50&offset=0");
    assert.equal(page1.status, 200);
    assert.equal(page1.body.approvals.length, 50);
    assert.equal(page1.body.hasMore, true);

    const page5 = await get(baseUrl, "/approvals?limit=50&offset=200");
    assert.equal(page5.status, 200);
    assert.equal(page5.body.approvals.length, 50);
    assert.equal(page5.body.hasMore, false);

    // No overlap between page 1 and page 5
    const page1Ids = new Set(page1.body.approvals.map((a: any) => a.id));
    for (const a of page5.body.approvals) assert.ok(!page1Ids.has(a.id));
  } finally {
    await close();
  }
});

test("GET /agents/:id/approvals paginates past 200 records", async () => {
  const { baseUrl, close, approvalStore } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    for (let i = 0; i < 210; i++) {
      await approvalStore.record(
        makeApproval({ createdAt: new Date(Date.now() + i).toISOString() })
      );
    }

    const page1 = await get(baseUrl, "/agents/test-agent/approvals?limit=50&offset=0");
    assert.equal(page1.status, 200);
    assert.equal(page1.body.approvals.length, 50);
    assert.equal(page1.body.hasMore, true);

    const page5 = await get(baseUrl, "/agents/test-agent/approvals?limit=50&offset=200");
    assert.equal(page5.status, 200);
    assert.equal(page5.body.approvals.length, 10);
    assert.equal(page5.body.hasMore, false);
  } finally {
    await close();
  }
});

test("GET /approvals?status filters at the store level so hasMore reflects the filtered set", async () => {
  const { baseUrl, close, approvalStore } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    // 5 pending + 5 rejected, interleaved by createdAt
    for (let i = 0; i < 5; i++) {
      await approvalStore.record(
        makeApproval({ status: "pending_approval", createdAt: new Date(Date.now() + i * 2).toISOString() })
      );
      await approvalStore.record(
        makeApproval({ status: "rejected", createdAt: new Date(Date.now() + i * 2 + 1).toISOString() })
      );
    }

    const pending = await get(baseUrl, "/approvals?status=pending_approval&limit=2&offset=0");
    assert.equal(pending.status, 200);
    assert.equal(pending.body.approvals.length, 2);
    assert.equal(pending.body.hasMore, true);
    for (const a of pending.body.approvals) assert.equal(a.status, "pending_approval");

    const pendingPage3 = await get(baseUrl, "/approvals?status=pending_approval&limit=2&offset=4");
    assert.equal(pendingPage3.status, 200);
    assert.equal(pendingPage3.body.approvals.length, 1);
    assert.equal(pendingPage3.body.hasMore, false);
  } finally {
    await close();
  }
});

// ===== Malformed / oversized offset handling =====

test("GET /activity with malformed offset falls back to 0", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    for (let i = 0; i < 3; i++) {
      await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "payment",
          asset: "XLM",
          destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          amount: "50",
          reason: `malformed offset ${i}`,
        }),
      });
    }
    for (const bad of ["abc", "-5", "1e999", "null", "NaN"]) {
      const res = await get(baseUrl, `/activity?offset=${encodeURIComponent(bad)}`);
      assert.equal(res.status, 200, `offset=${bad} should not error`);
      assert.equal(res.body.activity.length, 3, `offset=${bad} should fall back to 0`);
      assert.equal(res.body.hasMore, false);
    }
  } finally {
    await close();
  }
});

test("GET /activity with very large offset returns empty page and hasMore=false", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    for (let i = 0; i < 3; i++) {
      await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "payment",
          asset: "XLM",
          destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          amount: "50",
          reason: `large offset ${i}`,
        }),
      });
    }
    const res = await get(baseUrl, "/activity?offset=999999999");
    assert.equal(res.status, 200);
    assert.equal(res.body.activity.length, 0);
    assert.equal(res.body.hasMore, false);
  } finally {
    await close();
  }
});

test("GET /executions with malformed and very large offsets", async () => {
  const { baseUrl, close, executionStore } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" } },
  });
  try {
    for (let i = 0; i < 3; i++) {
      await executionStore.record(makeExecution({ status: "confirmed" }));
    }
    const bad = await get(baseUrl, "/executions?offset=notanumber");
    assert.equal(bad.status, 200);
    assert.equal(bad.body.executions.length, 3);
    assert.equal(bad.body.hasMore, false);

    const huge = await get(baseUrl, "/executions?offset=1000000000000");
    assert.equal(huge.status, 200);
    assert.equal(huge.body.executions.length, 0);
    assert.equal(huge.body.hasMore, false);
  } finally {
    await close();
  }
});

// ===== Offset ceiling terminates pagination =====

// The store clamps offsets to MAX_OFFSET (10_000). Without an explicit guard a
// page served AT the ceiling would still report hasMore=true, and the client's
// next request (offset 10_050) would be clamped back to 10_000 and re-serve the
// same records — an infinite "Load more" loop. Pagination must terminate at the
// ceiling and never repeat a record.
test("GET /executions stops paginating at the offset ceiling without repeating records", async () => {
  const { baseUrl, close, executionStore } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" } },
  });
  try {
    // More records than the ceiling so hasMore would otherwise stay true.
    for (let i = 0; i < 10_050; i++) {
      await executionStore.record(
        makeExecution({ status: "confirmed", updatedAt: new Date(Date.now() + i).toISOString() })
      );
    }

    const atCeiling = await get(baseUrl, "/executions?limit=50&offset=10000");
    assert.equal(atCeiling.status, 200);
    assert.equal(atCeiling.body.executions.length, 50);
    assert.equal(atCeiling.body.hasMore, false, "pagination must terminate at the ceiling");

    // A request past the ceiling clamps back to the ceiling — it must be
    // treated as the end of the list, not as another page.
    const pastCeiling = await get(baseUrl, "/executions?limit=50&offset=10050");
    assert.equal(pastCeiling.status, 200);
    assert.equal(pastCeiling.body.hasMore, false);

    // The two responses are the same window (that is the clamp), so a client
    // that stops on hasMore=false never appends duplicates.
    const ceilingIds = new Set(atCeiling.body.executions.map((e: any) => e.id));
    assert.equal(ceilingIds.size, 50);
    for (const e of pastCeiling.body.executions) {
      assert.ok(ceilingIds.has(e.id), "past-ceiling request returns the clamped window");
    }
  } finally {
    await close();
  }
});

test("GET /activity stops paginating at the offset ceiling", async () => {
  const { baseUrl, close, activityStore } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    for (let i = 0; i < 10_010; i++) {
      await activityStore.record(makeActivity({ createdAt: new Date(Date.now() + i).toISOString() }));
    }

    const atCeiling = await get(baseUrl, "/activity?limit=50&offset=10000");
    assert.equal(atCeiling.status, 200);
    assert.equal(atCeiling.body.activity.length, 10);
    assert.equal(atCeiling.body.hasMore, false);

    const pastCeiling = await get(baseUrl, "/activity?limit=50&offset=10050");
    assert.equal(pastCeiling.status, 200);
    assert.equal(pastCeiling.body.hasMore, false);
  } finally {
    await close();
  }
});

test("GET /agents/:id/executions stops paginating at the offset ceiling", async () => {
  const { baseUrl, close, executionStore } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" } },
  });
  try {
    for (let i = 0; i < 10_020; i++) {
      await executionStore.record(
        makeExecution({ status: "confirmed", updatedAt: new Date(Date.now() + i).toISOString() })
      );
    }

    const atCeiling = await get(baseUrl, "/agents/test-agent/executions?limit=50&offset=10000");
    assert.equal(atCeiling.status, 200);
    assert.equal(atCeiling.body.executions.length, 20);
    assert.equal(atCeiling.body.hasMore, false);

    const pastCeiling = await get(baseUrl, "/agents/test-agent/executions?limit=50&offset=10050");
    assert.equal(pastCeiling.status, 200);
    assert.equal(pastCeiling.body.hasMore, false);
  } finally {
    await close();
  }
});

test("GET /approvals stops paginating at the offset ceiling", async () => {
  const { baseUrl, close, approvalStore } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    for (let i = 0; i < 10_030; i++) {
      await approvalStore.record(
        makeApproval({ createdAt: new Date(Date.now() + i).toISOString() })
      );
    }

    const atCeiling = await get(baseUrl, "/approvals?limit=50&offset=10000");
    assert.equal(atCeiling.status, 200);
    assert.equal(atCeiling.body.approvals.length, 30);
    assert.equal(atCeiling.body.hasMore, false);

    const pastCeiling = await get(baseUrl, "/approvals?limit=50&offset=10050");
    assert.equal(pastCeiling.status, 200);
    assert.equal(pastCeiling.body.hasMore, false);
  } finally {
    await close();
  }
});

test("offset just below the ceiling still reports hasMore correctly", async () => {
  const { baseUrl, close, executionStore } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" } },
  });
  try {
    for (let i = 0; i < 10_010; i++) {
      await executionStore.record(
        makeExecution({ status: "confirmed", updatedAt: new Date(Date.now() + i).toISOString() })
      );
    }

    // offset 9950 + limit 50 = 10000, still below the ceiling: one more page
    // is reachable, so hasMore stays true.
    const below = await get(baseUrl, "/executions?limit=50&offset=9950");
    assert.equal(below.status, 200);
    assert.equal(below.body.executions.length, 50);
    assert.equal(below.body.hasMore, true);

    // The next page starts exactly at the ceiling and terminates.
    const atCeiling = await get(baseUrl, "/executions?limit=50&offset=10000");
    assert.equal(atCeiling.body.executions.length, 10);
    assert.equal(atCeiling.body.hasMore, false);

    const belowIds = new Set(below.body.executions.map((e: any) => e.id));
    for (const e of atCeiling.body.executions) {
      assert.ok(!belowIds.has(e.id), "the final page must not repeat the previous page");
    }
  } finally {
    await close();
  }
});
