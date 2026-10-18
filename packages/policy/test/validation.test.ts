import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePolicyRules, validatePolicyRules } from "../src/validation.js";

test("validatePolicyRules rejects non-object input", () => {
  for (const input of [null, "not an object", []]) {
    const result = validatePolicyRules(input);
    assert.equal(result.valid, false);
    assert.ok(result.errors.includes("Policy must be an object"));
  }
});

test("validatePolicyRules checks maxTxAmount values", () => {
  for (const amount of ["not-a-number", 0, -1]) {
    const result = validatePolicyRules({ maxTxAmount: { XLM: amount } });
    assert.equal(result.valid, false);
    assert.ok(result.errors.includes(`maxTxAmount.XLM must be a positive number, got ${amount}`));
  }
});

test("dailySpendingLimit accepts zero and rejects negative values", () => {
  assert.deepEqual(validatePolicyRules({ dailySpendingLimit: { XLM: 0 } }), { valid: true, errors: [] });
  const result = validatePolicyRules({ dailySpendingLimit: { XLM: -1 } });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("dailySpendingLimit.XLM must be a non-negative number, got -1"));
});

test("approvalThreshold accepts zero and rejects negative or non-numeric values", () => {
  assert.deepEqual(validatePolicyRules({ approvalThreshold: 0 }), { valid: true, errors: [] });
  for (const value of [-1, "not-a-number"]) {
    const result = validatePolicyRules({ approvalThreshold: value });
    assert.equal(result.valid, false);
    assert.ok(result.errors.includes(`approvalThreshold must be a non-negative number, got ${value}`));
  }
});

test("allowedAssets must be an array of non-empty strings", () => {
  const wrongType = validatePolicyRules({ allowedAssets: "XLM" });
  assert.equal(wrongType.valid, false);
  assert.ok(wrongType.errors.includes("allowedAssets must be an array"));

  const blankEntry = validatePolicyRules({ allowedAssets: ["   "] });
  assert.equal(blankEntry.valid, false);
  assert.ok(blankEntry.errors.includes("allowedAssets[0] must be a non-empty string"));
});

test("allowedDestinations must be an array of G addresses with the expected length", () => {
  const wrongType = validatePolicyRules({ allowedDestinations: "G" });
  assert.equal(wrongType.valid, false);
  assert.ok(wrongType.errors.includes("allowedDestinations must be an array"));

  const invalidAddress = validatePolicyRules({ allowedDestinations: [`G${"A".repeat(54)}`] });
  assert.equal(invalidAddress.valid, false);
  assert.ok(invalidAddress.errors.some((error) => error.startsWith("allowedDestinations[0] must be a valid Stellar address")));
});

test("allowedContractIds rejects blank identifiers", () => {
  const result = validatePolicyRules({ allowedContractIds: ["  "] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("allowedContractIds[0] must be a non-empty string"));
});

test("txTypeRestrictions rejects unknown keys and non-boolean values", () => {
  const result = validatePolicyRules({ txTypeRestrictions: { transfer: true, payment: "yes" } });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("txTypeRestrictions.transfer is not a supported transaction type"));
  assert.ok(result.errors.includes("txTypeRestrictions.payment must be a boolean"));
});

test("normalizePolicyRules fills defaults for an empty object", () => {
  assert.deepEqual(normalizePolicyRules({}), {
    maxTxAmount: { XLM: "100" },
    dailySpendingLimit: { XLM: "500" },
    allowedAssets: ["XLM"],
    allowedDestinations: [],
    allowedContractIds: [],
    txTypeRestrictions: { payment: true, trustline: true, contract_call: false, account_settings: false },
    approvalThreshold: "50",
    requireHumanApprovalForAmountAbove: "50",
  });
});

test("normalizePolicyRules keeps the approval threshold aliases in sync", () => {
  assert.equal(normalizePolicyRules({ approvalThreshold: "7" }).requireHumanApprovalForAmountAbove, "7");
  assert.equal(normalizePolicyRules({ requireHumanApprovalForAmountAbove: "9" }).approvalThreshold, "9");
});
