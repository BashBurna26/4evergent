import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/index.js";
import { DevAuthProvider } from "@4evergent/shared";
import type { PolicyRules } from "@4evergent/shared";
import type { AddressInfo } from "node:net";
import {
  InMemoryActivityStore,
  InMemoryAgentStore,
  InMemoryApprovalStore,
  InMemoryExecutionStore,
} from "@4evergent/database";
import type { ApprovalRecord, ExecutionRecord } from "@4evergent/database";

declare const fetch: typeof globalThis.fetch;

const TEST_INTENT = {
  type: "payment" as const,
  asset: "XLM",
  destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  amount: "10",
  reason: "dashboard endpoint test",
};

function makeApproval(ownerId: string, id: string, status: ApprovalRecord["status"] = "pending_approval"): ApprovalRecord {
  const now = new Date().toISOString();
  return {
    id,
    activityId: `activity-${id}`,
    agentId: "dashboard-agent",
    ownerId,
    intent: TEST_INTENT,
    policyDecision: { result: "requires_approval", reason: "test", rule: "test", intent: TEST_INTENT },
    status,
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
  };
}

function makeExecution(ownerId: string, id: string, status: ExecutionRecord["status"]): ExecutionRecord {
  const now = new Date().toISOString();
  return {
    id,
    ownerId,
    agentId: "dashboard-agent",
    approvalId: null,
    activityId: null,
    intent: TEST_INTENT,
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
  };
}

async function startServer(opts: {
  auth?: boolean;
  policyRules?: Partial<PolicyRules>;
  registerAgent?: boolean;
} = {}) {
  const activityStore = new InMemoryActivityStore();
  const approvalStore = new InMemoryApprovalStore();
  const executionStore = new InMemoryExecutionStore();
  const agentId = `dashboard-agent-${crypto.randomUUID()}`;
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: {
      getAccountId: () => "GTEST",
      getNetworkPassphrase: () => "Test SDF Network ; September 2015",
      sign: async (transaction: any) => transaction,
    },
    activityStore,
    approvalStore,
    executionStore,
    agentStore: new InMemoryAgentStore(),
    authProvider: opts.auth === false
      ? undefined
      : new DevAuthProvider({ defaultOwnerId: "owner-a", apiKeys: { "owner-b-token": "owner-b" } }),
    policyRules: opts.policyRules,
  });

  if (opts.registerAgent !== false) {
    server.registerAgent({
      id: agentId,
      displayName: "Dashboard Test Agent",
      description: "dashboard endpoint fixture",
      ownerId: "owner-a",
      stellarAddress: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      capabilities: ["payment"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      active: true,
      status: "active",
      metadata: {},
    });
  }

  await server.listen(0);
  const address = server.server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => server.close(),
    activityStore,
    approvalStore,
    executionStore,
    agentId,
  };
}

async function request(baseUrl: string, path: string, token?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    keepalive: false,
  });
  return { status: response.status, body: await response.json() };
}

test("GET /overview/attention returns zero dashboard counters for a fresh owner", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const response = await request(baseUrl, "/overview/attention");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      pendingApprovals: 0,
      failedExecutions: 0,
      deadLetterExecutions: 0,
      retryingExecutions: 0,
      stuckExecutions: 0,
    });
  } finally {
    await close();
  }
});

test("GET /overview/attention counts statuses for the authenticated owner only", async () => {
  const { baseUrl, close, approvalStore, executionStore } = await startServer();
  try {
    await approvalStore.record(makeApproval("owner-a", "pending-a"));
    await approvalStore.record(makeApproval("owner-a", "approved-a", "approved"));
    await approvalStore.record(makeApproval("owner-b", "pending-b"));
    for (const [id, status] of [
      ["queued-a", "queued"],
      ["executing-a", "executing"],
      ["failed-a", "failed"],
      ["dead-letter-a", "dead_letter"],
      ["cancelled-a", "cancelled"],
      ["submitted-a", "submitted"],
      ["confirmed-a", "confirmed"],
      ["failed-b", "failed"],
    ] as const) {
      await executionStore.record(makeExecution(id === "failed-b" ? "owner-b" : "owner-a", id, status));
    }

    const response = await request(baseUrl, "/overview/attention");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      pendingApprovals: 1,
      failedExecutions: 1,
      deadLetterExecutions: 1,
      retryingExecutions: 1,
      stuckExecutions: 1,
    });
  } finally {
    await close();
  }
});

test("GET /overview/attention returns the exact pendingApprovals count above 200 approvals", async () => {
  const { baseUrl, close, approvalStore } = await startServer();
  try {
    for (let index = 0; index < 205; index++) {
      await approvalStore.record(makeApproval("owner-a", `pending-${index}`));
    }
    // Non-pending rows and another owner's rows must not affect the count.
    for (let index = 0; index < 3; index++) {
      await approvalStore.record(makeApproval("owner-a", `approved-${index}`, "approved"));
    }
    for (let index = 0; index < 2; index++) {
      await approvalStore.record(makeApproval("owner-b", `other-pending-${index}`));
    }

    const response = await request(baseUrl, "/overview/attention");
    assert.equal(response.status, 200);
    // Counted in the store, not derived from a capped list: no silent truncation at 200.
    assert.equal(response.body.pendingApprovals, 205);
  } finally {
    await close();
  }
});

test("GET /agents/:id/spending returns dashboard budget values for configured assets", async () => {
  const { baseUrl, close, activityStore, agentId } = await startServer({
    policyRules: { dailySpendingLimit: { XLM: "100", USDC: "200", EXACT: "25", INVALID: "not-a-number" } },
  });
  try {
    await activityStore.reserveDailySpending(agentId, "USDC", "75", "200");
    await activityStore.reserveDailySpending(agentId, "EXACT", "25", "25");

    const response = await request(baseUrl, `/agents/${agentId}/spending`);
    assert.equal(response.status, 200);
    assert.equal(response.body.agentId, agentId);
    assert.deepEqual(response.body.spending, {
      XLM: { used: 0, limit: "100", remaining: 100 },
      USDC: { used: 75, limit: "200", remaining: 125 },
      EXACT: { used: 25, limit: "25", remaining: 0 },
    });
    assert.equal(Object.hasOwn(response.body.spending, "INVALID"), false);
    assert.ok(Object.values(response.body.spending).every((entry: any) => entry.remaining >= 0));
  } finally {
    await close();
  }
});

test("GET /overview/attention and GET /agents/:id/spending require authentication", async () => {
  const { baseUrl, close, agentId } = await startServer({ auth: false });
  try {
    const attention = await request(baseUrl, "/overview/attention");
    const spending = await request(baseUrl, `/agents/${agentId}/spending`);
    assert.equal(attention.status, 401);
    assert.equal(spending.status, 401);
  } finally {
    await close();
  }
});

test("GET /agents/:id/spending returns 404 when the agent belongs to another owner", async () => {
  const { baseUrl, close, agentId } = await startServer();
  try {
    const response = await request(baseUrl, `/agents/${agentId}/spending`, "owner-b-token");
    assert.equal(response.status, 404);
  } finally {
    await close();
  }
});
