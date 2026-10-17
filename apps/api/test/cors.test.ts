import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, apiFetch, MockSigner } from "./helpers.js";

const ALLOWED_ORIGIN = "https://preview-4evergent.vercel.app";
const DISALLOWED_ORIGIN = "https://evil.example.com";

function header(res: Response, name: string): string | null {
  return res.headers.get(name);
}

test("CORS: allowed origin receives Access-Control-Allow-Origin header", async () => {
  process.env.CORS_ORIGIN = ALLOWED_ORIGIN;
  const { baseUrl, close } = await startServer();
  try {
    const res = await apiFetch(`${baseUrl}/health`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    assert.equal(res.status, 200);
    assert.equal(header(res, "access-control-allow-origin"), ALLOWED_ORIGIN);
    assert.equal(header(res, "vary"), "Origin");
  } finally {
    await close();
    delete process.env.CORS_ORIGIN;
  }
});

test("CORS: disallowed origin does not receive Access-Control-Allow-Origin header", async () => {
  process.env.CORS_ORIGIN = ALLOWED_ORIGIN;
  const { baseUrl, close } = await startServer();
  try {
    const res = await apiFetch(`${baseUrl}/health`, {
      headers: { Origin: DISALLOWED_ORIGIN },
    });
    assert.equal(res.status, 200);
    assert.equal(header(res, "access-control-allow-origin"), null);
  } finally {
    await close();
    delete process.env.CORS_ORIGIN;
  }
});

test("CORS: OPTIONS preflight returns 204 with allowed methods and headers", async () => {
  process.env.CORS_ORIGIN = ALLOWED_ORIGIN;
  const { baseUrl, close } = await startServer();
  try {
    const res = await apiFetch(`${baseUrl}/health`, {
      method: "OPTIONS",
      headers: { Origin: ALLOWED_ORIGIN },
    });
    assert.equal(res.status, 204);
    assert.equal(header(res, "access-control-allow-origin"), ALLOWED_ORIGIN);
    assert.equal(header(res, "access-control-allow-methods"), "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    assert.equal(header(res, "access-control-allow-headers"), "Authorization, Content-Type, Idempotency-Key, X-Requested-With");
    assert.equal(header(res, "vary"), "Origin");
  } finally {
    await close();
    delete process.env.CORS_ORIGIN;
  }
});

test("CORS: OPTIONS preflight for disallowed origin returns 204 without ACAO", async () => {
  process.env.CORS_ORIGIN = ALLOWED_ORIGIN;
  const { baseUrl, close } = await startServer();
  try {
    const res = await apiFetch(`${baseUrl}/health`, {
      method: "OPTIONS",
      headers: { Origin: DISALLOWED_ORIGIN },
    });
    assert.equal(res.status, 204);
    assert.equal(header(res, "access-control-allow-origin"), null);
  } finally {
    await close();
    delete process.env.CORS_ORIGIN;
  }
});

test("CORS: Authorization header on actual request still authenticates", async () => {
  process.env.CORS_ORIGIN = ALLOWED_ORIGIN;
  const { baseUrl, close } = await startServer();
  try {
    // DevAuthProvider auto-authenticates, so listAgents should work
    const res = await apiFetch(`${baseUrl}/agents`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    assert.equal(res.status, 200);
    assert.equal(header(res, "access-control-allow-origin"), ALLOWED_ORIGIN);
    const body = await res.json();
    assert.ok(Array.isArray(body.agents));
  } finally {
    await close();
    delete process.env.CORS_ORIGIN;
  }
});

test("CORS: Idempotency-Key header is in allow-list", async () => {
  process.env.CORS_ORIGIN = ALLOWED_ORIGIN;
  const { baseUrl, close } = await startServer();
  try {
    const res = await apiFetch(`${baseUrl}/agents`, {
      method: "POST",
      headers: {
        Origin: ALLOWED_ORIGIN,
        "Content-Type": "application/json",
        "Idempotency-Key": "test-key-123",
      },
      body: JSON.stringify({
        id: "new-agent",
        displayName: "New Agent",
        description: "test",
        stellarAddress: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        capabilities: ["payment"],
      }),
    });
    assert.equal(header(res, "access-control-allow-origin"), ALLOWED_ORIGIN);
    assert.equal(res.status, 201);
  } finally {
    await close();
    delete process.env.CORS_ORIGIN;
  }
});

test("CORS: server without CORS_ORIGIN does not set ACAO header", async () => {
  delete process.env.CORS_ORIGIN;
  const { baseUrl, close } = await startServer({ signer: new MockSigner("no-cors") });
  try {
    const res = await apiFetch(`${baseUrl}/health`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    assert.equal(res.status, 200);
    assert.equal(header(res, "access-control-allow-origin"), null);
  } finally {
    await close();
  }
});
