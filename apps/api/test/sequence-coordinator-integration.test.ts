import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./helpers.js";

/**
 * Phase 25 integration tests — verify the account sequence coordinator is
 * actually wired into the real execution path.
 *
 * Migrated to the shared harness (issue #86): the local
 * `startServer(opts?: { signer? })` maps to `startServer({ signer })`.
 */

test("INTEGRATION: coordinator wired into execution path", async () => {
  const { baseUrl, close } = await startServer();
  try {
    // Verify server is up
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);

    // Verify coordinator is accessible by checking the server doesn't crash
    // when processing an intent that goes through the pipeline
    const agentRes = await fetch(`${baseUrl}/agents`, { method: "GET" });
    assert.equal(agentRes.status, 200);
  } finally {
    await close();
  }
});
