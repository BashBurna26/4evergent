import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/index.js";
import { DevAuthProvider } from "@4evergent/shared";
import { generateRequestId, redactHeaders, redactBody, log } from "../src/logging.js";
import type { Signer } from "@4evergent/stellar";
import type { AddressInfo } from "node:net";

declare const fetch: typeof globalThis.fetch;

// --- helpers ---

class MockSigner implements Signer {
  private id: string;
  constructor(id: string) {
    this.id = id.startsWith("G") ? id : `G${id.padEnd(55, "A").slice(0, 55)}`;
  }
  getAccountId(): string {
    return this.id;
  }
  getNetworkPassphrase(): string {
    return "Test SDF Network ; September 2015";
  }
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
  status: "active" as const,
  metadata: {},
};

async function startServer(auth: boolean = true) {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner("test-agent"),
    authProvider: auth ? new DevAuthProvider({ defaultOwnerId: "test" }) : undefined,
  });
  server.registerAgent(TEST_AGENT);

  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    const http = server.server.listen(0, "127.0.0.1", () => {
      const addr = http.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
      });
    });
  });
}

/**
 * Captures everything written to process.stdout. Must be restored before
 * the test finishes so later tests keep writing to the real stdout.
 */
function captureConsoleLog(): { lines: string[]; restore: () => void } {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: any[]) => {
    lines.push(args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" "));
    return true;
  };
  return {
    lines,
    restore: () => {
      console.log = original;
    },
  };
}

function findRequestLine(lines: string[]): Record<string, unknown> | null {
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.includes("\"msg\":\"request completed\"")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        /* not JSON, skip */
      }
    }
  }
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// --- tests ---

test("request without X-Request-Id receives a generated one", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const requestId = res.headers.get("x-request-id");
    assert.ok(requestId, "X-Request-Id response header must be set");
    assert.match(requestId ?? "", UUID_RE, "generated ID must be a UUID");
  } finally {
    await close();
  }
});

test("request with X-Request-Id echoes the supplied value", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const supplied = "client-supplied-correlation-id";
    const res = await fetch(`${baseUrl}/health`, {
      headers: { "X-Request-Id": supplied },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-request-id"), supplied, "supplied ID must be echoed");
  } finally {
    await close();
  }
});

test("log line contains method, path, status, duration, requestId", async () => {
  const { baseUrl, close } = await startServer();
  const capture = captureConsoleLog();
  try {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);

    const entry = findRequestLine(capture.lines);
    assert.ok(entry, "a 'request completed' log line must be emitted");
    assert.equal(entry.method, "GET");
    assert.equal(entry.path, "/health");
    assert.equal(entry.status, 200);
    assert.equal(typeof entry.durationMs, "number");
    assert.ok((entry.durationMs as number) >= 0, "durationMs must be non-negative");
    assert.match(entry.requestId as string, UUID_RE, "requestId must be a UUID");
  } finally {
    capture.restore();
    await close();
  }
});

test("Authorization header is never written to the log", async () => {
  const { baseUrl, close } = await startServer();
  const capture = captureConsoleLog();
  try {
    const secret = "Bearer super-secret-token-abc123";
    const res = await fetch(`${baseUrl}/agents`, {
      headers: { Authorization: secret },
    });
    assert.equal(res.status, 200);

    const entry = findRequestLine(capture.lines);
    assert.ok(entry, "a log line must be emitted");
    assert.ok(
      !JSON.stringify(entry).includes("super-secret-token-abc123"),
      "Authorization header value must not appear in the log",
    );
    assert.ok(
      !JSON.stringify(entry).includes("Bearer"),
      "no Authorization value should be present",
    );
  } finally {
    capture.restore();
    await close();
  }
});

test("error responses include the correlation ID header", async () => {
  process.env.CORS_ORIGIN = "https://preview-4evergent.vercel.app";
  const { baseUrl, close } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/definitely-not-a-route`, {
      headers: { Origin: "https://preview-4evergent.vercel.app" },
    });
    assert.equal(res.status, 404);
    const requestId = res.headers.get("x-request-id");
    assert.ok(requestId, "404 responses must carry X-Request-Id");
    assert.match(requestId ?? "", UUID_RE);
  } finally {
    await close();
    delete process.env.CORS_ORIGIN;
  }
});

test("OPTIONS preflight also carries a correlation ID", async () => {
  process.env.CORS_ORIGIN = "https://preview-4evergent.vercel.app";
  const { baseUrl, close } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/health`, {
      method: "OPTIONS",
      headers: { Origin: "https://preview-4evergent.vercel.app" },
    });
    assert.equal(res.status, 204);
    assert.ok(res.headers.get("x-request-id"), "preflight must carry X-Request-Id");
  } finally {
    await close();
    delete process.env.CORS_ORIGIN;
  }
});

test("ownerId is null without authProvider and set with auth", async () => {
  // Server WITHOUT authProvider — all requests unauthenticated, ownerId null
  const { baseUrl: noAuthBaseUrl, close: closeNoAuth } = await startServer(false);
  const noAuthCapture = captureConsoleLog();
  try {
    await fetch(`${noAuthBaseUrl}/health`);

    const entry = findRequestLine(noAuthCapture.lines);
    assert.ok(entry, "health request must be logged");
    assert.equal(entry.ownerId, null, "request without authProvider has null ownerId");
  } finally {
    noAuthCapture.restore();
    await closeNoAuth();
  }

  // Server WITH authProvider — ownerId is set
  const { baseUrl, close } = await startServer();
  const capture = captureConsoleLog();
  try {
    await fetch(`${baseUrl}/health`);

    const entry = findRequestLine(capture.lines);
    assert.ok(entry, "health request must be logged");
    assert.equal(entry.ownerId, "test", "authenticated request carries the ownerId");
  } finally {
    capture.restore();
    await close();
  }
});

// ─── Direct tests: redactHeaders ─────────────────────────────────────────────

test("redactHeaders redacts Authorization and Idempotency-Key", () => {
  const headers = {
    Authorization: "Bearer secret-token-123",
    "Idempotency-Key": "secret-key-456",
    "Content-Type": "application/json",
    "X-Custom": "visible",
  };
  const redacted = redactHeaders(headers);
  assert.equal(redacted["Authorization"], "[REDACTED]");
  assert.equal(redacted["Idempotency-Key"], "[REDACTED]");
  assert.equal(redacted["Content-Type"], "application/json");
  assert.equal(redacted["X-Custom"], "visible");
});

test("redactHeaders handles undefined and empty", () => {
  assert.deepEqual(redactHeaders(undefined), {});
  assert.deepEqual(redactHeaders({}), {});
});

// ─── Direct tests: redactBody ────────────────────────────────────────────────

test("redactBody redacts stellarAddress in JSON", () => {
  const body = JSON.stringify({
    from: "GABC123",
    to: "GDEF456",
    stellarAddress: "GSECRET789",
    amount: "100",
  });
  const redacted = redactBody(body);
  assert.ok(redacted);
  const parsed = JSON.parse(redacted);
  assert.equal(parsed.stellarAddress, "[REDACTED]");
  assert.equal(parsed.from, "GABC123");
  assert.equal(parsed.to, "GDEF456");
});

test("redactBody redacts nested stellarAddress", () => {
  const body = JSON.stringify({
    outer: {
      inner: {
        stellarAddress: "GNESTED999",
        other: "visible",
      },
    },
  });
  const redacted = redactBody(body);
  assert.ok(redacted);
  const parsed = JSON.parse(redacted);
  assert.equal(parsed.outer.inner.stellarAddress, "[REDACTED]");
  assert.equal(parsed.outer.inner.other, "visible");
});

test("redactBody passes through non-sensitive JSON", () => {
  const body = JSON.stringify({ foo: "bar", count: 42 });
  const redacted = redactBody(body);
  assert.ok(redacted);
  const parsed = JSON.parse(redacted);
  assert.equal(parsed.foo, "bar");
  assert.equal(parsed.count, 42);
});

test("redactBody handles undefined and non-JSON", () => {
  assert.equal(redactBody(undefined), undefined);
  assert.equal(redactBody("not json"), "not json");
});

// ─── Direct tests: LOG_LEVEL filtering ───────────────────────────────────────

test("LOG_LEVEL=warn suppresses info logs", () => {
  const original = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "warn";
  try {
    const capture = captureConsoleLog();
    try {
      log("info", "should be suppressed");
      log("warn", "should appear");
      log("error", "should also appear");
      const lines = capture.lines;
      assert.equal(lines.length, 2);
      assert.ok(lines[0].includes("should appear"));
      assert.ok(lines[1].includes("should also appear"));
    } finally {
      capture.restore();
    }
  } finally {
    if (original === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = original;
    }
  }
});

test("LOG_LEVEL=debug allows all levels", () => {
  const original = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "debug";
  try {
    const capture = captureConsoleLog();
    try {
      log("debug", "debug msg");
      log("info", "info msg");
      log("warn", "warn msg");
      log("error", "error msg");
      assert.equal(capture.lines.length, 4);
    } finally {
      capture.restore();
    }
  } finally {
    if (original === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = original;
    }
  }
});

// ─── Direct tests: generateRequestId validation ──────────────────────────────

test("generateRequestId echoes valid supplied ID", () => {
  assert.equal(generateRequestId("my-request-123"), "my-request-123");
  assert.equal(generateRequestId("abc_def-123.456"), "abc_def-123.456");
});

test("generateRequestId rejects overlong IDs", () => {
  const longId = "a".repeat(257);
  const result = generateRequestId(longId);
  assert.notEqual(result, longId);
  assert.match(result, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("generateRequestId rejects IDs with unsafe characters", () => {
  const result = generateRequestId("bad id with spaces!@#");
  assert.notEqual(result, "bad id with spaces!@#");
  assert.match(result, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("generateRequestId generates UUID for undefined/empty", () => {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  assert.match(generateRequestId(undefined), uuidPattern);
  assert.match(generateRequestId(""), uuidPattern);
});
