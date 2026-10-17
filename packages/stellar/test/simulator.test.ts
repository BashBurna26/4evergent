import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  type Horizon,
  type Transaction,
} from "@stellar/stellar-sdk";
import { StellarSimulator } from "../src/simulator.js";

/**
 * Unit tests for `StellarSimulator` — the mandatory pre-signing gate.
 *
 * Every test is offline: a fake `Horizon.Server` is injected via the
 * constructor seam (production callers keep the default `new Horizon.Server`).
 *
 * Dependency note: these tests assert the *current* check-6 behaviour (XLM
 * payment vs native balance). Sibling issue #43 ("Fix simulator balance check
 * to use the payment's actual asset") will change check 6; the balance tests
 * here must be updated when that fix lands.
 */

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const HORIZON_URL = "https://horizon-testnet.stellar.org";

type FakeAccount = {
  sequence: string;
  balances: { asset_type: string; balance: string; asset_code?: string }[];
  subentry_count?: number;
};

function fakeAccount(opts: {
  sequence: string;
  balances?: { asset_type: string; balance: string; asset_code?: string }[];
  subentry_count?: number;
}): FakeAccount {
  return {
    sequence: opts.sequence,
    subentry_count: opts.subentry_count ?? 0,
    balances: opts.balances ?? [{ asset_type: "native", balance: "100.0000000" }],
  };
}

/** Minimal stand-in for the two Horizon calls `simulate()` makes. */
function fakeServer(opts: { baseFee?: number | Error; account?: unknown | Error }): Horizon.Server {
  return {
    fetchBaseFee: async () => {
      if (opts.baseFee instanceof Error) throw opts.baseFee;
      return opts.baseFee ?? 100;
    },
    accounts: () => ({
      accountId: () => ({
        call: async () => {
          if (opts.account instanceof Error) throw opts.account;
          return opts.account;
        },
      }),
    }),
  } as unknown as Horizon.Server;
}

/** Build a real `Transaction` so the envelope round-trip is exercised. */
function buildTx(opts: {
  accountSequence: string;
  fee?: string;
  amount?: string;
}): Transaction {
  const source = new Account(SOURCE, opts.accountSequence);
  return new TransactionBuilder(source, {
    fee: opts.fee ?? "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({ destination: DEST, asset: Asset.native(), amount: opts.amount ?? "10" })
    )
    .setTimeout(30)
    .build();
}

// ── Check 1: envelope well-formedness ───────────────────────────────────────
test("SIMULATOR: invalid envelope returns simulation_failed", async () => {
  const sim = new StellarSimulator(HORIZON_URL, fakeServer({}));
  const tx = buildTx({ accountSequence: "100" });
  // Force the XDR round-trip to throw.
  (tx as unknown as { toEnvelope: () => unknown }).toEnvelope = () => {
    throw new Error("malformed XDR");
  };
  const result = await sim.simulate(tx);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /envelope is invalid/i);
});

// ── Check 2: base fee fetch ──────────────────────────────────────────────────
test("SIMULATOR: base fee fetch failure returns simulation_failed", async () => {
  const sim = new StellarSimulator(HORIZON_URL, fakeServer({ baseFee: new Error("network down") }));
  const tx = buildTx({ accountSequence: "100" });
  const result = await sim.simulate(tx);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /base fee/i);
});

// ── Check 3: source account existence ────────────────────────────────────────
test("SIMULATOR: account not found on network returns simulation_failed", async () => {
  const sim = new StellarSimulator(HORIZON_URL, fakeServer({ account: new Error("404 Not Found") }));
  const tx = buildTx({ accountSequence: "100" });
  const result = await sim.simulate(tx);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /not found on network/i);
});

// ── Check 4: sequence number precondition ────────────────────────────────────
test("SIMULATOR: sequence mismatch returns simulation_failed", async () => {
  const sim = new StellarSimulator(
    HORIZON_URL,
    fakeServer({ account: fakeAccount({ sequence: "100" }) })
  );
  // Build with account sequence "101" → tx.sequence === "102", but the fake
  // on-chain account is still at "100" → 102 !== 100 + 1.
  const tx = buildTx({ accountSequence: "101" });
  const result = await sim.simulate(tx);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /Sequence number mismatch/i);
});

// ── Check 5: fee precondition ────────────────────────────────────────────────
test("SIMULATOR: fee below network base fee returns simulation_failed", async () => {
  const sim = new StellarSimulator(
    HORIZON_URL,
    fakeServer({ baseFee: 100, account: fakeAccount({ sequence: "100" }) })
  );
  const tx = buildTx({ accountSequence: "100", fee: "50" });
  const result = await sim.simulate(tx);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /below network base fee/i);
});

// ── Check 6: balance precondition (current XLM behaviour) ────────────────────
test("SIMULATOR: insufficient balance returns simulation_failed", async () => {
  const sim = new StellarSimulator(
    HORIZON_URL,
    fakeServer({
      baseFee: 100,
      account: fakeAccount({
        sequence: "100",
        balances: [{ asset_type: "native", balance: "1.0000000" }],
      }),
    })
  );
  const tx = buildTx({ accountSequence: "100", fee: "100", amount: "10" });
  const result = await sim.simulate(tx);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /Insufficient balance/i);
});

// ── Check 6b: under-1-XLM warning ────────────────────────────────────────────
test("SIMULATOR: warns when remaining balance is under 1 XLM", async () => {
  // available = 10.6 - 0.5 = 10.1; totalCost = 10 + 0.00001 → remaining ≈ 0.09999 < 1
  const sim = new StellarSimulator(
    HORIZON_URL,
    fakeServer({
      baseFee: 100,
      account: fakeAccount({
        sequence: "100",
        balances: [{ asset_type: "native", balance: "10.6000000" }],
      }),
    })
  );
  const tx = buildTx({ accountSequence: "100", fee: "100", amount: "10" });
  const result = await sim.simulate(tx);
  assert.equal(result.success, true);
  assert.ok(
    result.warnings.some((w) => /under 1 XLM/.test(w)),
    `expected under-1-XLM warning, got: ${JSON.stringify(result.warnings)}`
  );
});

// ── Success path ─────────────────────────────────────────────────────────────
test("SIMULATOR: valid transaction returns success", async () => {
  const sim = new StellarSimulator(
    HORIZON_URL,
    fakeServer({
      baseFee: 100,
      account: fakeAccount({
        sequence: "100",
        balances: [{ asset_type: "native", balance: "100.0000000" }],
      }),
    })
  );
  const tx = buildTx({ accountSequence: "100", fee: "100", amount: "10" });
  const result = await sim.simulate(tx);
  assert.equal(result.success, true);
  assert.equal(result.fee, "100");
  assert.equal(result.operations, 1);
  assert.deepEqual(result.warnings, []);
});
