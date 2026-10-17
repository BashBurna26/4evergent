import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/index.js";
import { DevAuthProvider } from "@4evergent/shared";
import { Keypair } from "@stellar/stellar-sdk";
import type { Signer } from "@4evergent/stellar";
import type { PolicyRules } from "@4evergent/shared";
import type { AddressInfo } from "node:net";

// Node 18+ has global fetch; declare it for TS
declare const fetch: typeof globalThis.fetch;

// NOTE: integration tests start a real HTTP server in-process on an ephemeral
// port. They do NOT call the live Stellar testnet — all network-dependent
// pipeline steps (simulation, submission) are blocked by policy DENY
// or requires_approval gates before they can reach a network call.

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
  displayName: "Test",
  description: "test agent",
  ownerId: "test",
  stellarAddress: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  capabilities: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  active: true,
  metadata: {},
};

async function startServer(opts?: { policyRules?: Partial<PolicyRules>; signer?: Signer }) {
  const signer = opts?.signer ?? new MockSigner("test-agent");
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer,
    policyRules: opts?.policyRules,
    authProvider: new DevAuthProvider({ defaultOwnerId: "test" }),
  });
  server.registerAgent(TEST_AGENT);

  return new Promise<{
    baseUrl: string;
    close: () => Promise<void>;
    store: typeof server.store;
  }>((resolve) => {
    const http = server.server.listen(0, "127.0.0.1", () => {
      const addr = http.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
        store: server.store,
      });
    });
  });
}

async function post(baseUrl: string, path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(baseUrl: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
}

test("API returns 400 for invalid JSON body", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/agents/test-agent/intents`, {
      method: "POST",
      body: "not json",
    });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.error, "invalid JSON body");
  } finally {
    await close();
  }
});

test("API returns 400 for raw XDR submission", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await post(baseUrl, "/agents/test-agent/intents", { xdr: "AAAA..." });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.includes("raw XDR"));
  } finally {
    await close();
  }
});

test("API returns 400 for raw operations array", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await post(baseUrl, "/agents/test-agent/intents", { operations: [{ type: "payment" }] });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.includes("raw XDR"));
  } finally {
    await close();
  }
});

test("API returns 400 for tx_blob field", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await post(baseUrl, "/agents/test-agent/intents", { tx_blob: "AAAA..." });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.includes("raw XDR"));
  } finally {
    await close();
  }
});

test("API returns 404 for unknown agent", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await post(baseUrl, "/agents/unknown-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "1",
      reason: "test",
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "agent not found");
  } finally {
    await close();
  }
});

test("API returns 400 for missing amount in payment intent", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      reason: "test",
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.includes("amount"));
  } finally {
    await close();
  }
});

test("API returns 403 for policy-denied intent (amount exceeds maxTxAmount)", async () => {
  const rules: Partial<PolicyRules> = { maxTxAmount: { XLM: "0.001" } };
  const { baseUrl, close } = await startServer({ policyRules: rules });
  try {
    const res = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "10",
      reason: "exceeds limit",
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.status, "rejected");
    assert.equal(res.body.authorizationStatus, "denied_by_policy");
  } finally {
    await close();
  }
});

test("API returns 202 for approval-required intent", async () => {
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close } = await startServer({ policyRules: rules });
  try {
    const res = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "50",
      reason: "approval test",
    });
    assert.equal(res.status, 202);
    assert.equal(res.body.status, "requires_approval");
    assert.equal(res.body.authorizationStatus, "pending_approval");
  } finally {
    await close();
  }
});

test("API accepts trustline intent and routes to policy/approval", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const issuer = Keypair.random().publicKey();
    const res = await post(baseUrl, "/agents/test-agent/intents", {
      type: "trustline",
      assetCode: "USDC",
      issuer,
      reason: "test trustline",
    });
    // Trustline is now supported — should pass validation and enter policy evaluation
    assert.ok(res.status === 202 || res.status === 403, `expected 202 or 403, got ${res.status}`);
  } finally {
    await close();
  }
});

test("API rejects unsupported intent type (contract_call)", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await post(baseUrl, "/agents/test-agent/intents", {
      type: "contract_call",
      contractId: "some-contract",
      function: "do_thing",
      args: [],
      reason: "test",
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.includes("not yet supported"));
  } finally {
    await close();
  }
});

test("API accepts account_settings intent (no longer 'not yet supported')", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await post(baseUrl, "/agents/test-agent/intents", {
      type: "account_settings",
      setting: "inflation_dest",
      value: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      reason: "test",
    });
    // parseIntent now accepts account_settings — the intent reaches policy
    // evaluation (may be denied by default policy, but NOT by "not yet supported")
    assert.ok(
      !res.body.error?.includes("not yet supported"),
      `account_settings should not be rejected as 'not yet supported', got: ${res.body.error}`
    );
  } finally {
    await close();
  }
});

test("API health endpoint returns signer account id", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await get(baseUrl, "/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ok");
    assert.equal(res.body.signerAccountId.length, 56);
    assert.ok(res.body.signerAccountId.startsWith("Gtest-agent"));
  } finally {
    await close();
  }
});

test("API records activity for denied intent", async () => {
  const rules: Partial<PolicyRules> = { maxTxAmount: { XLM: "0.001" } };
  const { baseUrl, close, store } = await startServer({ policyRules: rules });
  try {
    await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "10",
      reason: "exceeds limit",
    });

    const records = await store.listByAgent("test-agent");
    assert.equal(records.length, 1);
    assert.equal(records[0]!.status, "rejected");
    assert.equal(records[0]!.authorizationStatus, "denied_by_policy");
  } finally {
    await close();
  }
});

test("API records activity for approval-required intent", async () => {
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close, store } = await startServer({ policyRules: rules });
  try {
    await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "approval test",
    });

    const records = await store.listByAgent("test-agent");
    assert.equal(records.length, 1);
    assert.equal(records[0]!.status, "requires_approval");
    assert.equal(records[0]!.authorizationStatus, "pending_approval");
  } finally {
    await close();
  }
});

test("API response does not contain private keys or secrets", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "100",
      reason: "verify no sensitive data",
    });
    // Should be requires_approval (amount > 10 threshold)
    const json = JSON.stringify(res);
    assert.ok(!json.includes("secret"));
    assert.ok(!json.includes("seed"));
    assert.ok(!json.includes("private_key"));
    assert.ok(!json.includes("Keypair"));
  } finally {
    await close();
  }
});
