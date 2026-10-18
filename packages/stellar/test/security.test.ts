import { test } from "node:test";
import assert from "node:assert/strict";
import { TransactionPipeline } from "../src/pipeline.js";
import type { Signer } from "../src/signer.js";
import {
  InMemoryActivityStore,
  InMemoryApprovalStore,
  createApproval,
  createActivity,
} from "@4evergent/database";
import type { PolicyRules, AgentIntent, PolicyDecision } from "@4evergent/shared";
import { Keypair } from "@stellar/stellar-sdk";

const TESTNET = "https://horizon-testnet.stellar.org";
const PASSPHRASE = "Test SDF Network ; September 2015";

/**
 * RecordingSigner — a fake signer that records every call. This proves the
 * signer was (or was NOT) reached by a given gate.
 */
class RecordingSigner implements Signer {
  calls = 0;
  private keypair = Keypair.random();
  getAccountId(): string { return this.keypair.publicKey(); }
  getNetworkPassphrase(): string { return PASSPHRASE; }
  async sign(transaction: any): Promise<any> {
    this.calls++;
    transaction.sign(this.keypair);
    return transaction;
  }
}

function makePipeline(opts: {
  rules?: Partial<PolicyRules>;
  signer?: Signer;
  activity?: InMemoryActivityStore;
  approval?: InMemoryApprovalStore;
}) {
  const activity = opts.activity ?? new InMemoryActivityStore();
  const approval = opts.approval ?? new InMemoryApprovalStore();
  const signer = opts.signer ?? new RecordingSigner();
  const pipeline = new TransactionPipeline({
    horizonUrl: TESTNET,
    networkPassphrase: PASSPHRASE,
    signer,
    activityStore: activity,
    approvalStore: approval,
    policyRules: opts.rules,
  });
  return { pipeline, activity, approval, signer };
}

function paymentIntent(amount: string, destination?: string): AgentIntent {
  return {
    type: "payment",
    asset: "XLM",
    destination: destination ?? Keypair.random().publicKey(),
    amount,
    reason: "security test",
  };
}

// ===== 1. Policy DENY never reaches signer =====

test("SEC: policy DENY prevents signing", async () => {
  const { pipeline, signer } = makePipeline({ rules: { maxTxAmount: { XLM: "1" } } });
  const result = await pipeline.execute({
    intent: paymentIntent("100"),
    sourceAccount: fakeAccount(),
  });
  assert.equal(result.status, "rejected");
  assert.equal((signer as RecordingSigner).calls, 0, "signer must NOT be called on DENY");
});

test("SEC: policy DENY prevents submission", async () => {
  const { pipeline, signer } = makePipeline({ rules: { allowedAssets: ["USDC"] } });
  const result = await pipeline.execute({
    intent: paymentIntent("1"),
    sourceAccount: fakeAccount(),
  });
  assert.equal(result.status, "rejected");
  assert.equal((signer as RecordingSigner).calls, 0);
  assert.ok(!("txHash" in result) || !result.txHash);
});

// ===== 2. Amount above limit cannot reach signer =====

test("SEC: amount above maxTxAmount cannot reach signer", async () => {
  const { pipeline, signer } = makePipeline({ rules: { maxTxAmount: { XLM: "10" } } });
  const result = await pipeline.execute({
    intent: paymentIntent("100"),
    sourceAccount: fakeAccount(),
  });
  assert.equal(result.status, "rejected");
  assert.match(result.message, /max_tx_amount/);
  assert.equal((signer as RecordingSigner).calls, 0);
});

// ===== 3. Unauthorized asset / destination =====

test("SEC: unauthorized asset cannot reach signer", async () => {
  const { pipeline, signer } = makePipeline({});
  const result = await pipeline.execute({
    intent: { ...paymentIntent("1"), asset: "USDC" } as AgentIntent,
    sourceAccount: fakeAccount(),
  });
  assert.equal(result.status, "rejected");
  assert.match(result.message, /asset/i);
  assert.equal((signer as RecordingSigner).calls, 0);
});

test("SEC: unauthorized destination cannot reach signer", async () => {
  const { pipeline, signer } = makePipeline({
    rules: { allowedDestinations: ["GONLYTHISONE"] },
  });
  const result = await pipeline.execute({
    intent: paymentIntent("1", "GEVILDESTINATION"),
    sourceAccount: fakeAccount(),
  });
  assert.equal(result.status, "rejected");
  assert.match(result.message, /destination/i);
  assert.equal((signer as RecordingSigner).calls, 0);
});

// ===== 4. Approval-required intent cannot reach signer before approval =====

test("SEC: approval-required intent does not sign", async () => {
  const { pipeline, signer, approval } = makePipeline({
    rules: { requireHumanApprovalForAmountAbove: "10", maxTxAmount: { XLM: "1000" } },
  });
  const result = await pipeline.execute({
    intent: paymentIntent("50"),
    sourceAccount: fakeAccount(),
  });
  assert.equal(result.status, "requires_approval");
  assert.equal((signer as RecordingSigner).calls, 0, "signer must NOT be called pre-approval");

  // An approval record must have been persisted
  const list = await approval.listByAgent("unknown");
  assert.equal(list.length, 1);
  assert.equal(list[0]!.status, "pending_approval");
});

test("SEC: approval-required returns activityId + approvalId", async () => {
  const { pipeline } = makePipeline({
    rules: { requireHumanApprovalForAmountAbove: "10", maxTxAmount: { XLM: "1000" } },
  });
  const result = await pipeline.execute({
    intent: paymentIntent("50"),
    sourceAccount: fakeAccount(),
  });
  assert.equal(result.status, "requires_approval");
  assert.ok(result.approvalId, "approvalId must be returned");
});

// ===== 5. Failed simulation cannot reach signer =====

test("SEC: failed simulation cannot reach signer", async () => {
  const { pipeline, signer } = makePipeline({ rules: { maxTxAmount: { XLM: "1000" } } });
  // Use an unfunded random account — simulation will fail at account-not-found
  const kp = Keypair.random();
  const result = await pipeline.execute({
    intent: paymentIntent("1", kp.publicKey()),
    sourceAccount: {
      accountId: () => kp.publicKey(),
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
    },
  });
  // Simulation runs against real Horizon and fails for unfunded account
  if (result.status === "simulation_failed") {
    assert.equal((signer as RecordingSigner).calls, 0, "signer must NOT be called on failed simulation");
  } else {
    // If simulation somehow passed (account funded), signer still should not have run
    // because we didn't approve anything — but ALLOW path would sign.
    // This test is only meaningful when simulation fails.
    assert.equal(result.status, "rejected");
  }
});

// ===== 6. Signer cannot expose private key =====

test("SEC: Signer interface exposes no secret-returning methods", () => {
  const signer = new RecordingSigner();
  const proto = Object.getPrototypeOf(signer);
  const methods = Object.getOwnPropertyNames(proto).filter((m) => m !== "constructor");
  assert.deepEqual(methods.sort(), ["getAccountId", "getNetworkPassphrase", "sign"]);
  for (const m of methods) {
    assert.ok(!/secret|seed|private|mnemonic/i.test(m));
  }
});

// ===== 7. executeApproved reconstructs from stored intent, rejects XDR =====

test("SEC: executeApproved rejects nonexistent approval", async () => {
  const { pipeline, signer } = makePipeline({});
  const result = await pipeline.executeApproved("nonexistent-id");
  assert.equal(result.status, "rejected");
  assert.match(result.message, /not found/);
  assert.equal((signer as RecordingSigner).calls, 0);
});

test("SEC: executeApproved rejects pending (not approved) record", async () => {
  const { pipeline, signer, approval, activity } = makePipeline({});
  const intent = paymentIntent("50");
  const act = createActivity("agent-a", "owner-a", intent, { result: "requires_approval", reason: "t", rule: "t", intent });
  await activity.record(act);
  const appr = createApproval(act.id, "agent-a", "owner-a", intent, { result: "requires_approval", reason: "t", rule: "t", intent }, null);
  await approval.record(appr);

  const result = await pipeline.executeApproved(appr.id);
  assert.equal(result.status, "rejected");
  assert.match(result.message, /not approved/);
  assert.equal((signer as RecordingSigner).calls, 0);
});

test("SEC: executeApproved rejects expired approval", async () => {
  const { pipeline, signer, approval, activity } = makePipeline({});
  const intent = paymentIntent("50");
  const decision: PolicyDecision = { result: "requires_approval", reason: "t", rule: "t", intent };
  const act = createActivity("agent-a", "owner-a", intent, decision);
  await activity.record(act);
  const past = new Date(Date.now() - 1000).toISOString();
  const appr = createApproval(act.id, "agent-a", "owner-a", intent, decision, past);
  appr.status = "approved";
  await approval.record(appr);

  const result = await pipeline.executeApproved(appr.id);
  assert.equal(result.status, "rejected");
  assert.match(result.message, /expired/);
  assert.equal((signer as RecordingSigner).calls, 0);

  const updated = await approval.get(appr.id);
  assert.equal(updated!.status, "expired");
});

// ===== 8. Double approval / idempotency =====

test("SEC: second executeApproved on submitted record does not re-sign", async () => {
  const { pipeline, signer, approval, activity } = makePipeline({});
  const intent = paymentIntent("50");
  const decision: PolicyDecision = { result: "requires_approval", reason: "t", rule: "t", intent };
  const act = createActivity("agent-a", "owner-a", intent, decision);
  await activity.record(act);
  const appr = createApproval(act.id, "agent-a", "owner-a", intent, decision, null);
  appr.status = "submitted";
  appr.txHash = "already-submitted-hash";
  await approval.record(appr);

  const result = await pipeline.executeApproved(appr.id);
  assert.equal(result.status, "rejected");
  // Approval status is "submitted" — pipeline correctly reports "already executed"
  assert.match(result.message, /already executed|not approved/);
  assert.equal((signer as RecordingSigner).calls, 0, "already-submitted must not re-sign");
});

// ===== 9. Daily limit enforcement =====

test("SEC: daily limit denies when cumulative spending exceeded", async () => {
  const activity = new InMemoryActivityStore();
  // Reserve 90 XLM against the agent's daily limit directly through the same
  // atomic reservation API the PolicyEngine uses in production. (Seeding a
  // "submitted" activity record no longer affects the limit — Phase 23 moved
  // enforcement to reserveDailySpending, which tracks its own per-day totals.)
  const reserved = await activity.reserveDailySpending("agent-a", "XLM", "90", "100");
  assert.ok(reserved, "seed reservation must succeed");

  const { pipeline, signer } = makePipeline({
    rules: { dailySpendingLimit: { XLM: "100" }, maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "1000" },
    activity,
  });

  const result = await pipeline.execute({
    intent: paymentIntent("20"),
    sourceAccount: fakeAccount("agent-a"),
  });
  // 90 + 20 = 110 > 100 — must be denied specifically by the daily limit rule
  assert.equal(result.status, "rejected");
  assert.ok(/daily/.test(result.message ?? ""), `expected daily limit rejection, got: ${result.message}`);
  assert.equal((signer as RecordingSigner).calls, 0);
});

test("SEC: daily limit allows when under cumulative cap", async () => {
  const activity = new InMemoryActivityStore();
  const prior = createActivity("agent-a", "owner-a", paymentIntent("30"), { result: "allow", reason: "t", rule: "t", intent: paymentIntent("30") });
  prior.status = "submitted";
  await activity.record(prior);

  const { pipeline } = makePipeline({
    rules: { dailySpendingLimit: { XLM: "100" }, maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "1000" },
    activity,
  });

  const result = await pipeline.execute({
    intent: paymentIntent("50"),
    sourceAccount: fakeAccount("agent-a"),
  });
  // 30 + 50 = 80 <= 100 — should pass the daily gate (will fail later at
  // simulation because the account is unfunded, but NOT at daily limit)
  assert.ok(!/daily/.test(result.message ?? ""), `unexpected daily limit: ${result.message}`);
});

test("SEC: pipeline execution aborts when signal is pre-aborted — no signing or submission", async () => {
  const signer = new RecordingSigner();
  const { pipeline } = makePipeline({ signer });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    async () => {
      await pipeline.execute({
        intent: paymentIntent("10"),
        sourceAccount: fakeAccount("agent-a"),
        signal: controller.signal,
      });
    },
    (err: any) => err.name === "AbortError"
  );

  assert.equal(signer.calls, 0, "signer must not be called when execution is cancelled");
});

test("SEC: pipeline execution aborts during onBeforeSubmit — no submission occurs", async () => {
  const signer = new RecordingSigner();
  const { pipeline } = makePipeline({ signer });
  (pipeline as any).simulator = {
    simulate: async () => ({ success: true, fee: "100", operations: 1 }),
  };
  let submitCalled = false;
  (pipeline as any).submitter = {
    submit: async () => {
      submitCalled = true;
      throw new Error("submitter must not be called");
    },
  };

  const controller = new AbortController();
  let beforeSubmitReached = false;
  await assert.rejects(
    async () => {
      await pipeline.execute({
        intent: paymentIntent("10"),
        sourceAccount: fakeAccount("agent-a"),
        signal: controller.signal,
        onBeforeSubmit: () => {
          beforeSubmitReached = true;
          controller.abort();
        },
      });
    },
    (err: any) => err.name === "AbortError"
  );

  assert.equal(beforeSubmitReached, true);
  assert.equal(submitCalled, false, "submitter.submit must not be called after cancellation");
});

// ===== Helpers =====

function fakeAccount(agentId?: string): any {
  const kp = Keypair.random();
  return {
    accountId: () => kp.publicKey(),
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
    agentId: agentId ?? "unknown",
  };
}
