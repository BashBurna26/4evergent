import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/index.js";
import { DevAuthProvider } from "@4evergent/shared";

async function post(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = res.status !== 204 ? await res.json() : null;
  return { status: res.status, body: json };
}

function makeSigner(accountId: string): any {
  return {
    getAccountId: () => accountId,
    getNetworkPassphrase: () => "Test SDF Network ; September 2015",
    sign: async (tx: any) => tx,
  };
}

test("POST /agents happy path", async () => {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: makeSigner("GTEST"),
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  await server.listen(0);
  const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;
  try {
    const res = await post(`${baseUrl}/agents`, {
      displayName: "My Agent",
      description: "Test agent",
      capabilities: ["payment"],
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.agent);
    assert.equal(res.body.agent.displayName, "My Agent");
    assert.equal(res.body.agent.description, "Test agent");
    assert.deepEqual(res.body.agent.capabilities, ["payment"]);
    assert.equal(res.body.agent.ownerId, "owner-a");
    assert.equal(res.body.agent.status, "active");
    assert.ok(res.body.agent.id);
  } finally {
    await server.close();
  }
});

test("POST /agents minimal — only displayName required", async () => {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: makeSigner("GTEST"),
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  await server.listen(0);
  const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;
  try {
    const res = await post(`${baseUrl}/agents`, { displayName: "Minimal" });
    assert.equal(res.status, 201);
    assert.equal(res.body.agent.displayName, "Minimal");
    assert.equal(res.body.agent.description, "");
    assert.deepEqual(res.body.agent.capabilities, []);
    assert.equal(res.body.agent.status, "active");
  } finally {
    await server.close();
  }
});

test("POST /agents validation — missing displayName", async () => {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: makeSigner("GTEST"),
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  await server.listen(0);
  const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;
  try {
    const res = await post(`${baseUrl}/agents`, {});
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "displayName is required");
  } finally {
    await server.close();
  }
});

test("POST /agents validation — empty displayName", async () => {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: makeSigner("GTEST"),
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  await server.listen(0);
  const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;
  try {
    const res = await post(`${baseUrl}/agents`, { displayName: "  " });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "displayName is required");
  } finally {
    await server.close();
  }
});

test("POST /agents validation — displayName too long", async () => {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: makeSigner("GTEST"),
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  await server.listen(0);
  const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;
  try {
    const res = await post(`${baseUrl}/agents`, { displayName: "x".repeat(101) });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "displayName must be 100 characters or fewer");
  } finally {
    await server.close();
  }
});

test("POST /agents validation — invalid capabilities", async () => {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: makeSigner("GTEST"),
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  await server.listen(0);
  const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;
  try {
    const res = await post(`${baseUrl}/agents`, { displayName: "Test", capabilities: "not-an-array" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "capabilities must be an array of strings");
  } finally {
    await server.close();
  }
});

test("POST /agents validation — invalid stellarAddress", async () => {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: makeSigner("GTEST"),
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  await server.listen(0);
  const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;
  try {
    const res = await post(`${baseUrl}/agents`, { displayName: "Test", stellarAddress: 123 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "stellarAddress must be a string");
  } finally {
    await server.close();
  }
});

test("POST /agents owner isolation — agent belongs to requesting owner", async () => {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: makeSigner("GTEST"),
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  await server.listen(0);
  const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;
  try {
    const res = await post(`${baseUrl}/agents`, { displayName: "Owner A Agent" });
    assert.equal(res.status, 201);
    assert.equal(res.body.agent.ownerId, "owner-a");

    // Agent should appear in owner-a's list
    const listRes = await fetch(`${baseUrl}/agents`);
    const listBody = await listRes.json();
    assert.equal(listBody.agents.length, 1);
    assert.equal(listBody.agents[0].id, res.body.agent.id);
  } finally {
    await server.close();
  }
});

test("POST /agents cross-owner — cannot see other owner's agents", async () => {
  const serverA = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: makeSigner("GTEST"),
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  await serverA.listen(0);
  const baseUrlA = `http://127.0.0.1:${(serverA.server.address() as any).port}`;

  const serverB = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: makeSigner("GTEST"),
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-b" }),
  });
  await serverB.listen(0);
  const baseUrlB = `http://127.0.0.1:${(serverB.server.address() as any).port}`;
  try {
    const resA = await post(`${baseUrlA}/agents`, { displayName: "Agent A" });
    assert.equal(resA.status, 201);

    // owner-b should not see owner-a's agents
    const listB = await fetch(`${baseUrlB}/agents`);
    const listBodyB = await listB.json();
    assert.equal(listBodyB.agents.length, 0);

    // owner-b cannot access owner-a's agent detail
    const detailB = await fetch(`${baseUrlB}/agents/${resA.body.agent.id}`);
    assert.equal(detailB.status, 404);
  } finally {
    await serverA.close();
    await serverB.close();
  }
});

test("POST /agents created agent can be used for intent submission", async () => {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: makeSigner("GTEST"),
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
    deferExecution: true,
  });
  await server.listen(0);
  const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;
  try {
    const agentRes = await post(`${baseUrl}/agents`, { displayName: "Intent Test Agent" });
    assert.equal(agentRes.status, 201);
    const agentId = agentRes.body.agent.id;

    // Submit intent to newly created agent (amount >= approvalThreshold to trigger 202)
    const intentRes = await post(`${baseUrl}/agents/${agentId}/intents`, {
      type: "payment",
      asset: "XLM",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "60",
      reason: "test intent for new agent",
    });
    assert.equal(intentRes.status, 202); // requires_approval
  } finally {
    await server.close();
  }
});

test("POST /agents validation — description too long", async () => {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: makeSigner("GTEST"),
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  await server.listen(0);
  const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;
  try {
    const res = await post(`${baseUrl}/agents`, {
      displayName: "Valid Name",
      description: "x".repeat(501),
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "description must be 500 characters or fewer");
  } finally {
    await server.close();
  }
});

test("POST /agents validation — description not a string", async () => {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: makeSigner("GTEST"),
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  await server.listen(0);
  const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;
  try {
    const res = await post(`${baseUrl}/agents`, {
      displayName: "Valid Name",
      description: 12345,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "description must be a string");
  } finally {
    await server.close();
  }
});

test("POST /agents validation — capabilities over count", async () => {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: makeSigner("GTEST"),
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  await server.listen(0);
  const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;
  try {
    const caps = Array.from({ length: 33 }, (_, i) => `cap-${i}`);
    const res = await post(`${baseUrl}/agents`, {
      displayName: "Valid Name",
      capabilities: caps,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "capabilities must be 32 entries or fewer");
  } finally {
    await server.close();
  }
});

test("POST /agents validation — capability entry over length", async () => {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: makeSigner("GTEST"),
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  await server.listen(0);
  const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;
  try {
    const res = await post(`${baseUrl}/agents`, {
      displayName: "Valid Name",
      capabilities: ["a".repeat(33)],
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "capability entries must be 32 characters or fewer");
  } finally {
    await server.close();
  }
});

test("POST /agents validation — empty capability entry", async () => {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: makeSigner("GTEST"),
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  await server.listen(0);
  const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;
  try {
    const resEmpty = await post(`${baseUrl}/agents`, {
      displayName: "Valid Name",
      capabilities: [""],
    });
    assert.equal(resEmpty.status, 400);
    assert.equal(resEmpty.body.error, "capability entries cannot be empty");

    const resWhitespace = await post(`${baseUrl}/agents`, {
      displayName: "Valid Name",
      capabilities: ["   "],
    });
    assert.equal(resWhitespace.status, 400);
    assert.equal(resWhitespace.body.error, "capability entries cannot be empty");
  } finally {
    await server.close();
  }
});

test("POST /agents validation — duplicate capabilities rejected", async () => {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: makeSigner("GTEST"),
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  await server.listen(0);
  const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;
  try {
    const resDup = await post(`${baseUrl}/agents`, {
      displayName: "Valid Name",
      capabilities: ["payment", "payment"],
    });
    assert.equal(resDup.status, 400);
    assert.equal(resDup.body.error, "capabilities must not contain duplicate entries");

    const resDupTrimmed = await post(`${baseUrl}/agents`, {
      displayName: "Valid Name",
      capabilities: ["payment", " payment "],
    });
    assert.equal(resDupTrimmed.status, 400);
    assert.equal(resDupTrimmed.body.error, "capabilities must not contain duplicate entries");
  } finally {
    await server.close();
  }
});

test("POST /agents validation — exactly-at-limit values accepted", async () => {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: makeSigner("GTEST"),
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  await server.listen(0);
  const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;
  try {
    const exactly500Desc = "d".repeat(500);
    const exactly32Caps = Array.from({ length: 32 }, (_, i) => `c${i}`.padEnd(32, "x"));
    const res = await post(`${baseUrl}/agents`, {
      displayName: "n".repeat(100),
      description: exactly500Desc,
      capabilities: exactly32Caps,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.agent.displayName, "n".repeat(100));
    assert.equal(res.body.agent.description, exactly500Desc);
    assert.equal(res.body.agent.capabilities.length, 32);
    assert.deepEqual(res.body.agent.capabilities, exactly32Caps);
  } finally {
    await server.close();
  }
});

test("POST /agents capabilities are trimmed", async () => {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: makeSigner("GTEST"),
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  await server.listen(0);
  const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;
  try {
    const res = await post(`${baseUrl}/agents`, {
      displayName: "Trim Test",
      capabilities: ["  payment  ", " swap "],
    });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.agent.capabilities, ["payment", "swap"]);
  } finally {
    await server.close();
  }
});
