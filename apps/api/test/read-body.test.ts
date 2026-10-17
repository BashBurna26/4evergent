/**
 * Unit tests for readBody (apps/api/src/index.ts).
 *
 * readBody is the body parser used by every request handler. Its single
 * behavioural guarantee is rejecting any body larger than 1 MB while
 * streaming. These tests exercise that contract directly using fake
 * request objects built from node:stream.
 *
 * Related: issue #18 — the streaming-continues-after-reject defect.
 * These tests assert the *intended* behaviour (reject > 1 MB), not the
 * buggy behaviour (buffering continues after rejection).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readBody } from "../src/index.js";

const ONE_MB = 1024 * 1024; // 1,048,576

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a fake "request" object — a Readable stream with no headers — that
 * emits the supplied chunks and then ends.  Mirrors how the HTTP server
 * passes the IncomingMessage to readBody.
 */
function makeRequest(chunks: Buffer[] | string[]): Readable {
  return Readable.from(chunks.map((c) => (typeof c === "string" ? Buffer.from(c) : c)));
}

/** A Readable that emits an `error` event instead of ending normally. */
function makeErrorRequest(error: Error): Readable {
  return new Readable({
    read() {
      this.destroy(error);
    },
  });
}

/** A Readable that never emits data or end. */
function makeHangingRequest(): Readable {
  return new Readable({
    read() {
      // Intentionally never push or push(null)
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("small body resolves to its string content", async () => {
  const req = makeRequest(["hello", " ", "world"]);
  const result = await readBody(req);
  assert.equal(result, "hello world");
});

test("empty body (immediate end) resolves to empty string", async () => {
  const req = makeRequest([]);
  const result = await readBody(req);
  assert.equal(result, "");
});

test("body larger than 1 MB rejects with 'body too large'", async () => {
  // 1 MB + 1 byte — strictly over the limit
  const over = Buffer.alloc(ONE_MB + 1, "x");
  const req = makeRequest([over]);
  await assert.rejects(
    () => readBody(req),
    (err: Error) => {
      assert.ok(
        err.message.includes("body too large"),
        `expected message to include "body too large", got: ${err.message}`,
      );
      return true;
    },
  );
});

test("body exactly at 1,048,576 characters resolves (boundary is strictly greater-than)", async () => {
  // Exactly 1 MB — the current code rejects only when data.length > ONE_MB,
  // so a body of exactly ONE_MB bytes should resolve.
  const exact = Buffer.alloc(ONE_MB, "x");
  const req = makeRequest([exact]);
  const result = await readBody(req);
  assert.equal(result.length, ONE_MB);
});

test("stream that emits an error rejects with that error", async () => {
  const streamError = new Error("connection reset");
  const req = makeErrorRequest(streamError);
  await assert.rejects(
    () => readBody(req),
    (err: Error) => {
      assert.equal(err, streamError, "should reject with the original error object");
      return true;
    },
  );
});

test("stream that never ends leaves the promise unsettled", async () => {
  const req = makeHangingRequest();
  let settled = false;
  const promise = readBody(req).then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  // Wait 50 ms — if the promise settled in that window, the test fails.
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  assert.equal(settled, false, "promise must remain pending when the stream never ends");

  // Clean up so the event loop isn't held open
  req.destroy(new Error("cleanup"));
  // The destroy triggers the 'error' listener readBody attached, so the
  // promise rejects — catch it to avoid an unhandled rejection.
  await promise.catch(() => {});
});
