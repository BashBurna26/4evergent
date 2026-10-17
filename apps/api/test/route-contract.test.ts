import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/index.js";
import { createAuthModule } from "../src/auth.js";
import { DevAuthProvider } from "@4evergent/shared";
import type { Signer } from "@4evergent/stellar";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import {
  InMemoryActivityStore,
  InMemoryApprovalStore,
  InMemoryExecutionStore,
  InMemoryScheduleStore,
  InMemoryAgentStore,
} from "@4evergent/database";
import type {
  ActivityStore,
  ApprovalStore,
  ExecutionStore,
  ScheduleStore,
  ExecutionRecord,
  ScheduleRecord,
  ApprovalRecord,
  ActivityRecord,
} from "@4evergent/database";

declare const fetch: typeof globalThis.fetch;

// ============================================================================
// ROUTE SURFACE — the contract this suite guards
// ============================================================================
// This table is the single place that enumerates every route served by
// apps/api/src/index.ts (the dispatch chain at index.ts:627-716) plus the
// public /auth/* routes handled by auth.ts before the auth gate.
//
// WHEN YOU ADD A ROUTE TO index.ts, ADD IT HERE.
// A route missing from this table is a gap in the contract: nothing asserts
// its method, auth requirement, status code, or response shape.
//
// Fields:
//   method   — HTTP method the route is dispatched on
//   path     — concrete path with :id placeholders filled by `sample`
//   auth     — "public"   → reachable without a principal (must NOT be 401)
//              "protected" → requires a principal (anonymous must be 401)
//   status   — status code the success path returns for the seeded fixture
//   keys     — top-level response keys the success path must contain
//   sample   — optional per-route fixture setup, returns the concrete path
//              (and any extra request options) to use for the success probe
// ============================================================================

type RouteAuth = "public" | "protected";

interface RouteContract {
  method: string;
  /** Path template; `:id` segments are substituted by `sample()`. */
  path: string;
  auth: RouteAuth;
  /** Expected status on the success path for the seeded fixture. */
  status: number;
  /** Top-level response keys required on the success path. */
  keys?: string[];
  /** True when the route returns a top-level array collection. */
  list?: boolean;
  /**
   * Build the concrete request for the success probe. Receives the ids of
   * fixtures created during setup. Return the resolved path and any
   * method-specific request init.
   */
  sample?: (ids: FixtureIds) => { path: string; init?: RequestInit };
  /** Set to true when the route is only reachable with the queue enabled. */
  needsQueue?: boolean;
}

interface FixtureIds {
  agentId: string;
  activityId: string;
  approvalId: string;
  executionId: string;
  queuedExecutionId: string;
  scheduleId: string;
  missingId: string;
}

const AGENT_ID = "contract-agent";

const ROUTES: RouteContract[] = [
  // ---- Public routes (no principal required) ----
  { method: "GET", path: "/health", auth: "public", status: 200, keys: ["status", "signerAccountId"] },
  { method: "GET", path: "/auth/config", auth: "public", status: 200, keys: ["email", "google", "stellar", "registration"] },
  { method: "POST", path: "/auth/register", auth: "public", status: 201, keys: ["subject"] },
  { method: "POST", path: "/auth/login/email", auth: "public", status: 200, keys: ["subject"] },
  { method: "POST", path: "/auth/stellar/challenge", auth: "public", status: 200, keys: ["challengeId", "message", "expiresAt", "network"] },
  { method: "POST", path: "/auth/stellar/verify", auth: "public", status: 200, keys: ["subject"] },
  { method: "GET", path: "/auth/me", auth: "protected", status: 200, keys: ["subject", "ownerId", "method"] },
  { method: "GET", path: "/auth/google/start", auth: "public", status: 503, keys: ["error", "requiredEnv"] },
  { method: "GET", path: "/auth/google/callback", auth: "public", status: 302 },
  { method: "POST", path: "/auth/logout", auth: "public", status: 204 },

  // ---- Protected routes (anonymous → 401) ----
  { method: "POST", path: "/agents", auth: "protected", status: 201, keys: ["agent"], sample: () => ({
    path: "/agents",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Contract Agent" }),
    },
  }) },
  { method: "GET", path: "/agents", auth: "protected", status: 200, keys: ["agents"], list: true },
  {
    method: "GET",
    path: "/agents/:id",
    auth: "protected",
    status: 200,
    keys: ["id", "displayName", "ownerId", "stellarAddress"],
    sample: (ids) => ({ path: `/agents/${ids.agentId}` }),
  },
  {
    method: "GET",
    path: "/agents/:id/policy",
    auth: "protected",
    status: 200,
    keys: ["agentId", "policy"],
    sample: (ids) => ({ path: `/agents/${ids.agentId}/policy` }),
  },
  {
    method: "PUT",
    path: "/agents/:id/policy",
    auth: "protected",
    status: 200,
    keys: ["agentId", "policy", "version"],
    sample: (ids) => ({
      path: `/agents/${ids.agentId}/policy`,
      init: {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxTxAmount: { XLM: "1000" } }),
      },
    }),
  },
  {
    method: "PATCH",
    path: "/agents/:id/status",
    auth: "protected",
    status: 200,
    keys: ["id", "status"],
    sample: (ids) => ({
      path: `/agents/${ids.agentId}/status`,
      init: {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      },
    }),
  },
  {
    method: "POST",
    path: "/agents/:id/intents",
    auth: "protected",
    status: 202,
    sample: (ids) => ({
      path: `/agents/${ids.agentId}/intents`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "payment",
          asset: "XLM",
          destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          amount: "50",
          reason: "contract test",
        }),
      },
    }),
  },
  {
    method: "GET",
    path: "/agents/:id/activity",
    auth: "protected",
    status: 200,
    keys: ["agentId", "activity", "hasMore"], list: true,
    sample: (ids) => ({ path: `/agents/${ids.agentId}/activity` }),
  },
  {
    method: "GET",
    path: "/agents/:id/activity/:activityId",
    auth: "protected",
    status: 200,
    keys: ["activity"],
    sample: (ids) => ({ path: `/agents/${ids.agentId}/activity/${ids.activityId}` }),
  },
  {
    method: "GET",
    path: "/agents/:id/approvals",
    auth: "protected",
    status: 200,
    keys: ["agentId", "approvals", "hasMore"], list: true,
    sample: (ids) => ({ path: `/agents/${ids.agentId}/approvals` }),
  },
  {
    method: "GET",
    path: "/agents/:id/schedules",
    auth: "protected",
    status: 200,
    keys: ["agentId", "schedules", "hasMore"], list: true,
    sample: (ids) => ({ path: `/agents/${ids.agentId}/schedules` }),
  },
  {
    method: "GET",
    path: "/agents/:id/schedules/:scheduleId",
    auth: "protected",
    status: 200,
    keys: ["schedule"],
    sample: (ids) => ({ path: `/agents/${ids.agentId}/schedules/${ids.scheduleId}` }),
  },
  {
    method: "POST",
    path: "/agents/:id/schedules",
    auth: "protected",
    status: 201,
    keys: ["schedule"],
    sample: (ids) => ({
      path: `/agents/${ids.agentId}/schedules`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intent: {
            type: "payment",
            asset: "XLM",
            destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            amount: "10",
            reason: "contract schedule",
          },
          scheduleExpression: "0 0 * * *",
          timezone: "UTC",
        }),
      },
    }),
  },
  {
    method: "PATCH",
    path: "/agents/:id/schedules/:scheduleId",
    auth: "protected",
    status: 200,
    keys: ["schedule"],
    sample: (ids) => ({
      path: `/agents/${ids.agentId}/schedules/${ids.scheduleId}`,
      init: {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduleExpression: "30 0 * * *" }),
      },
    }),
  },
  {
    method: "POST",
    path: "/agents/:id/schedules/:scheduleId/pause",
    auth: "protected",
    status: 200,
    keys: ["schedule"],
    sample: (ids) => ({ path: `/agents/${ids.agentId}/schedules/${ids.scheduleId}/pause`, init: { method: "POST" } }),
  },
  {
    method: "GET",
    path: "/agents/:id/spending",
    auth: "protected",
    status: 200,
    keys: ["agentId", "spending"],
    sample: (ids) => ({ path: `/agents/${ids.agentId}/spending` }),
  },
  {
    method: "GET",
    path: "/agents/:id/executions",
    auth: "protected",
    status: 200,
    keys: ["agentId", "executions", "hasMore"], list: true,
    sample: (ids) => ({ path: `/agents/${ids.agentId}/executions` }),
  },
  { method: "GET", path: "/activity", auth: "protected", status: 200, keys: ["activity", "hasMore"], list: true },
  { method: "GET", path: "/approvals", auth: "protected", status: 200, keys: ["approvals", "hasMore"], list: true },
  {
    method: "GET",
    path: "/approvals/:id",
    auth: "protected",
    status: 200,
    keys: ["approval"],
    sample: (ids) => ({ path: `/approvals/${ids.approvalId}` }),
  },
  { method: "GET", path: "/executions", auth: "protected", status: 200, keys: ["executions", "hasMore"], list: true },
  {
    method: "GET",
    path: "/executions/:id",
    auth: "protected",
    status: 200,
    keys: ["execution"],
    sample: (ids) => ({ path: `/executions/${ids.executionId}` }),
  },
  { method: "GET", path: "/agent-queue", auth: "protected", status: 200, keys: ["running", "byStatus"], needsQueue: true },
  { method: "GET", path: "/overview/attention", auth: "protected", status: 200, keys: ["pendingApprovals", "failedExecutions"] },
  {
    method: "POST",
    path: "/executions/:id/retry",
    auth: "protected",
    status: 200,
    sample: (ids) => ({ path: `/executions/${ids.executionId}/retry`, init: { method: "POST" } }),
    needsQueue: true,
  },
  {
    method: "POST",
    path: "/executions/:id/cancel",
    auth: "protected",
    status: 200,
    keys: ["execution", "message"],
    sample: (ids) => ({ path: `/executions/${ids.queuedExecutionId}/cancel`, init: { method: "POST" } }),
    needsQueue: true,
  },
  {
    method: "POST",
    path: "/approvals/:id/approve",
    auth: "protected",
    status: 200,
    keys: ["approvalId", "activityId", "status", "message"],
    sample: (ids) => ({ path: `/approvals/${ids.approvalId}/approve`, init: { method: "POST" } }),
  },
  {
    method: "POST",
    path: "/approvals/:id/reject",
    auth: "protected",
    status: 200,
    keys: ["approvalId", "activityId", "status", "message"],
    sample: (ids) => ({ path: `/approvals/${ids.approvalId}/reject`, init: { method: "POST" } }),
  },
  {
    method: "POST",
    path: "/agents/:id/schedules/:scheduleId/resume",
    auth: "protected",
    status: 200,
    keys: ["schedule"],
    sample: (ids) => ({ path: `/agents/${ids.agentId}/schedules/${ids.scheduleId}/resume`, init: { method: "POST" } }),
  },
  {
    method: "POST",
    path: "/agents/:id/schedules/:scheduleId/disable",
    auth: "protected",
    status: 200,
    keys: ["schedule"],
    sample: (ids) => ({ path: `/agents/${ids.agentId}/schedules/${ids.scheduleId}/disable`, init: { method: "POST" } }),
  },
  {
    method: "DELETE",
    path: "/agents/:id/schedules/:scheduleId",
    auth: "protected",
    status: 200,
    keys: ["deleted"],
    sample: (ids) => ({ path: `/agents/${ids.agentId}/schedules/${ids.scheduleId}`, init: { method: "DELETE" } }),
  },
];

// ============================================================================
// Test harness
// ============================================================================

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

async function apiFetch(url: string, init?: RequestInit) {
  // redirect: "manual" keeps the raw response (e.g. 302 from /auth/google/callback)
  // instead of following cross-origin redirects the test server can't serve.
  return fetch(url, { ...init, keepalive: false, redirect: "manual" });
}

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
  stores: {
    activity: ActivityStore;
    approvals: ApprovalStore;
    executions: ExecutionStore;
    schedules: ScheduleStore;
  };
}

/**
 * Boots a server with in-memory stores and the dev auth provider, then seeds
 * the fixtures the route table's `sample()` closures reference.
 *
 * `withQueue` enables the execution queue so queue-dependent routes
 * (/agent-queue, /executions/:id/retry, /executions/:id/cancel) are reachable
 * instead of returning 404 "execution queue not enabled".
 */
async function startHarness(withQueue = false, withAuth = true): Promise<Harness> {
  const activity = new InMemoryActivityStore();
  const approvals = new InMemoryApprovalStore();
  const executions = new InMemoryExecutionStore();
  const schedules = new InMemoryScheduleStore();
  const agentStore = new InMemoryAgentStore();

  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner("contract-agent"),
    policyRules: {
      maxTxAmount: { XLM: "1000" },
      requireHumanApprovalForAmountAbove: "10",
    },
    deferExecution: true,
    authProvider: withAuth ? new DevAuthProvider({ defaultOwnerId: "test" }) : undefined,
    activityStore: activity,
    approvalStore: approvals,
    executionStore: executions,
    scheduleStore: schedules,
    agentStore,
    executionQueue: withQueue ? { enabled: true, intervalMs: 60_000, concurrency: 1 } : undefined,
    authModule: withAuth
      ? createAuthModule({
          fallbackProvider: new DevAuthProvider({ defaultOwnerId: "test" }),
          config: { webOrigin: "http://localhost:5173", stellarDomain: "localhost" },
        })
      : undefined,
  });

  server.registerAgent({
    id: AGENT_ID,
    displayName: "Contract Agent",
    description: "route contract fixture",
    ownerId: "test",
    stellarAddress: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    capabilities: ["payment"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    active: true,
    status: "active" as const,
    metadata: {},
  });

  await seedFixtures({ activity, approvals, executions, schedules });

  return new Promise((resolve) => {
    const http = server.server.listen(0, "127.0.0.1", () => {
      const addr = http.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
        stores: { activity, approvals, executions, schedules },
      });
    });
  });
}

function makeActivity(overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    ownerId: "test",
    agentId: AGENT_ID,
    intent: {
      type: "payment",
      asset: "XLM",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "50",
      reason: "contract fixture",
    },
    policyDecision: { decision: "allow", reasons: [] } as any,
    authorizationStatus: "not_required",
    status: "pending",
    txHash: null,
    simulationResult: null,
    error: null,
    idempotencyKey: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeApproval(activityId: string, overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    activityId,
    agentId: AGENT_ID,
    ownerId: "test",
    intent: {
      type: "payment",
      asset: "XLM",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "50",
      reason: "contract fixture",
    },
    policyDecision: { decision: "require_approval", reasons: ["above threshold"] } as any,
    status: "pending_approval",
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
    ...overrides,
  };
}

function makeExecution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    ownerId: "test",
    agentId: AGENT_ID,
    approvalId: null,
    activityId: null,
    intent: {
      type: "payment",
      asset: "XLM",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "50",
      reason: "contract fixture",
    },
    status: "queued",
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
    ...overrides,
  };
}

function makeSchedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    agentId: AGENT_ID,
    ownerId: "test",
    status: "active",
    intent: {
      type: "payment",
      asset: "XLM",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "10",
      reason: "contract fixture",
    },
    scheduleExpression: "0 0 * * *",
    timezone: "UTC",
    nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
    lastRunAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function seedFixtures(stores: {
  activity: ActivityStore;
  approvals: ApprovalStore;
  executions: ExecutionStore;
  schedules: ScheduleStore;
}): Promise<FixtureIds> {
  const activityRecord = makeActivity();
  await stores.activity.record(activityRecord);

  const approval = makeApproval(activityRecord.id);
  await stores.approvals.record(approval);

  // A queued execution so the cancel route has a valid target (cancel only
  // accepts queued/executing), plus a failed one for the retry route.
  const execution = makeExecution({ status: "failed" });
  await stores.executions.record(execution);
  const queuedExecution = makeExecution({ status: "queued" });
  await stores.executions.record(queuedExecution);

  const schedule = makeSchedule();
  await stores.schedules.create(schedule);

  return {
    agentId: AGENT_ID,
    activityId: activityRecord.id,
    approvalId: approval.id,
    executionId: execution.id,
    queuedExecutionId: queuedExecution.id,
    scheduleId: schedule.id,
    missingId: crypto.randomUUID(),
  };
}

// ============================================================================
// Route inventory — parsed from the dispatch chain source
// ============================================================================
// The API dispatch chain (apps/api/src/index.ts:627-716) and the auth module
// (apps/api/src/auth.ts handleRoutes) register routes as a flat sequence of
// `method === "M" && <path test>` conditions. Extracting them from the
// source gives an INDEPENDENT inventory: if a route is added to either file
// without a matching entry in the ROUTES table, the drift check below fails.

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

interface InventoryRoute {
  method: string;
  /** Regex source of the path test, e.g. ^\\/agents\\/([^/]+)$ */
  pattern?: string;
  /** Simple `url === "..."` comparison, when the route uses one. */
  literal?: string;
}

function extractRoutesFrom(source: string): InventoryRoute[] {
  const routes: InventoryRoute[] = [];
  // Matches: method === "GET" && url === "/health"
  //          method === "GET" && /^\/agents\/[^/]+$/.test(url)
  //          method === "GET" && path === "/auth/config"
  const re =
    /method\s*===\s*"(GET|POST|PUT|PATCH|DELETE)"\s*&&\s*(?:url|path)\s*===\s*"([^"]+)"|method\s*===\s*"(GET|POST|PUT|PATCH|DELETE)"\s*&&\s*(\/\^.*?\/)\.test\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m[2] !== undefined) {
      routes.push({ method: m[1]!, literal: m[2] });
    } else if (m[4] !== undefined) {
      routes.push({ method: m[3]!, pattern: m[4] });
    }
  }
  return routes;
}

/**
 * Normalizes a route to a canonical template so the source's regex form and
 * the table's `:param` form compare equal.
 *
 *   ^\/agents\/[^/]+$                      → /agents/<id>
 *   ^\/agents\/[^/]+\/activity(\?.*)?$     → /agents/<id>/activity
 *   ^\/agents\/[^/]+\/(pause|resume|disable)$ → 3 templates, one per action
 */
function canonicalTemplates(raw: string): string[] {
  const s = raw
    // Strip regex literal delimiters: /^\/agents$/
    .replace(/^\/(.*)\/$/, "$1")
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replace(/\\\//g, "/")
    .replace(/\(\?:/g, "(")
    // Drop optional query-string suffixes — the path is the same route.
    .replace(/\(\\\?\.\*\)\?/g, "")
    .replace(/\(\?\.\*\)\?/g, "")
    .replace(/\[\^\/\]\+/g, "<id>")
    .replace(/:([A-Za-z]+)/g, "<id>");

  // Expand a single alternation group into one template per alternative.
  const alt = s.match(/\(([^()]+)\)/);
  if (alt && alt[1]!.includes("|")) {
    return alt[1]!
      .split("|")
      .map((a) => s.replace(alt[0]!, a));
  }
  return [s];
}

function inventoryMatchesTable(inv: InventoryRoute[], table: RouteContract[]): string[] {
  const declared = new Set<string>();
  for (const t of table) {
    for (const tpl of canonicalTemplates(t.path)) declared.add(`${t.method} ${tpl}`);
  }

  const missing: string[] = [];
  for (const r of inv) {
    const templates = canonicalTemplates(r.literal ?? r.pattern!);
    for (const tpl of templates) {
      if (!declared.has(`${r.method} ${tpl}`)) {
        missing.push(`${r.method} ${tpl}`);
      }
    }
  }
  return [...new Set(missing)];
}

// ============================================================================
// Contract assertions
// ============================================================================

test("route table covers every route the server registers (drift check)", () => {
  // Parse the dispatch chain and auth module directly — an independent
  // inventory. A route added to either file without a table entry makes
  // THIS test fail, not a hand-maintained count.
  const apiSrc = readFileSync(join(TEST_DIR, "..", "src", "index.ts"), "utf8");
  const authSrc = readFileSync(join(TEST_DIR, "..", "src", "auth.ts"), "utf8");

  const apiRoutes = extractRoutesFrom(apiSrc);
  const authRoutes = extractRoutesFrom(authSrc);
  assert.ok(apiRoutes.length >= 30, `expected at least 30 routes in index.ts, found ${apiRoutes.length}`);
  assert.ok(authRoutes.length >= 9, `expected at least 9 routes in auth.ts, found ${authRoutes.length}`);

  const missing = inventoryMatchesTable([...apiRoutes, ...authRoutes], ROUTES);
  assert.deepEqual(
    missing,
    [],
    `routes registered by the server but missing from the ROUTES table — add them:\n  ${missing.join("\n  ")}`
  );

  // Every entry must be uniquely addressable.
  const seen = new Set<string>();
  for (const r of ROUTES) {
    const key = `${r.method} ${r.path}`;
    assert.ok(!seen.has(key), `duplicate route entry: ${key}`);
    seen.add(key);
  }
});

test("every protected route returns 401 for an anonymous request", async () => {
  // Boot WITHOUT an authProvider so authenticateRequest returns principal:null.
  // (DevAuthProvider would authenticate every request and mask the 401 path.)
  const { baseUrl, close } = await startHarness(false, false);
  try {
    for (const route of ROUTES.filter((r) => r.auth === "protected")) {
      const path = route.sample
        ? route.sample({
            agentId: AGENT_ID,
            activityId: "x",
            approvalId: "x",
            executionId: "x",
            queuedExecutionId: "x",
            scheduleId: "x",
            missingId: "x",
          }).path
        : route.path;

      const res = await apiFetch(`${baseUrl}${path}`, {
        method: route.method,
        headers: route.method === "GET" || route.method === "DELETE" ? undefined : { "Content-Type": "application/json" },
        body: route.method === "GET" || route.method === "DELETE" ? undefined : "{}",
      });

      assert.equal(
        res.status,
        401,
        `${route.method} ${route.path} must return 401 for an anonymous request (got ${res.status})`
      );
      const body = await res.json();
      assert.ok(body.error, `${route.method} ${route.path} 401 body must carry an error field`);
    }
  } finally {
    await close();
  }
});

test("every public route is reachable without a principal", async () => {
  const { baseUrl, close } = await startHarness();
  try {
    for (const route of ROUTES.filter((r) => r.auth === "public")) {
      const res = await apiFetch(`${baseUrl}${route.path}`, {
        method: route.method,
        headers: route.method === "GET" ? undefined : { "Content-Type": "application/json" },
        body: route.method === "GET" ? undefined : "{}",
      });

      // "Public" means the auth GATE must not reject it. A public route may
      // still return its own 4xx (e.g. /auth/login/email → 401 invalid_credentials
      // for empty creds) — that is a business decision, not the auth gate.
      // The gate's signature is error === "unauthorized".
      if (res.status === 401) {
        const body = await res.json();
        assert.notEqual(
          body.error,
          "unauthorized",
          `${route.method} ${route.path} is public — a 401 with error "unauthorized" means the auth gate rejected it`
        );
      }
    }
  } finally {
    await close();
  }
});

test("every non-auth route's success path returns its documented status code and top-level keys", async () => {
  const { baseUrl, close, stores } = await startHarness(true);
  try {
    for (const route of ROUTES.filter((r) => !r.path.startsWith("/auth/"))) {
      // Re-seed into the server's OWN stores before every probe, so
      // destructive routes (PATCH/DELETE) never break the ones after them.
      const ids = await seedFixtures(stores);
      void ids;

      const probe = route.sample ? route.sample(ids) : { path: route.path };
      const res = await apiFetch(`${baseUrl}${probe.path}`, probe.init);

      assert.equal(
        res.status,
        route.status,
        `${route.method} ${route.path} must return ${route.status} on the success path (got ${res.status})`
      );

      if (route.keys && route.keys.length > 0) {
        const body = await res.json();
        for (const key of route.keys) {
          assert.ok(
            key in body,
            `${route.method} ${route.path} response must contain top-level key '${key}'`
          );
        }
      }
    }
  } finally {
    await close();
  }
});

test("every /auth/* route returns its documented success status and top-level keys", async () => {
  const { baseUrl, close } = await startHarness();
  // Shared sequential state: register issues the session cookie /auth/me and
  // /auth/logout need, and the challenge issues the id+message the signed
  // verify needs. Order below reflects those dependencies.
  let cookie: string | null = null;
  let challengeId: string | null = null;
  let challengeMessage: string | null = null;
  const kp = Keypair.random();

  const jsonInit = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  // Assert against the ROUTES table itself — the documented contract is the
  // thing under test, so a wrong status or missing key in the table fails.
  const assertContract = async (method: string, path: string, res: Response) => {
    const entry = ROUTES.find((r) => r.method === method && r.path === path);
    assert.ok(entry, `ROUTES table has no entry for ${method} ${path}`);
    assert.equal(
      res.status,
      entry.status,
      `${method} ${path} must return ${entry.status} on the success path (got ${res.status})`
    );
    if (entry.keys && entry.keys.length > 0) {
      const body = await res.json();
      for (const key of entry.keys) {
        assert.ok(key in body, `${method} ${path} response must contain top-level key '${key}'`);
      }
    }
  };

  const exercised: string[] = [];
  try {
    // GET /auth/config
    exercised.push("GET /auth/config");
    await assertContract("GET", "/auth/config", await apiFetch(`${baseUrl}/auth/config`));

    // POST /auth/register — also captures the session cookie
    exercised.push("POST /auth/register");
    const reg = await apiFetch(
      `${baseUrl}/auth/register`,
      jsonInit({ email: "contract@example.com", password: "password123", displayName: "Contract" })
    );
    const setCookie = reg.headers.get("set-cookie");
    cookie = setCookie ? setCookie.split(";")[0]! : null;
    assert.ok(cookie, "register must issue a session cookie for /auth/me");
    await assertContract("POST", "/auth/register", reg);

    // GET /auth/me — authenticated with the cookie register issued
    exercised.push("GET /auth/me");
    await assertContract("GET", "/auth/me", await apiFetch(`${baseUrl}/auth/me`, { headers: { Cookie: cookie } }));

    // POST /auth/login/email
    exercised.push("POST /auth/login/email");
    await assertContract(
      "POST",
      "/auth/login/email",
      await apiFetch(`${baseUrl}/auth/login/email`, jsonInit({ email: "contract@example.com", password: "password123" }))
    );

    // POST /auth/stellar/challenge — captures challengeId + message
    exercised.push("POST /auth/stellar/challenge");
    const challenge = await apiFetch(`${baseUrl}/auth/stellar/challenge`, jsonInit({ publicKey: kp.publicKey() }));
    const chBody = await challenge.clone().json();
    challengeId = chBody.challengeId;
    challengeMessage = chBody.message;
    assert.ok(challengeId && challengeMessage, "challenge must return challengeId + message");
    await assertContract("POST", "/auth/stellar/challenge", challenge);

    // POST /auth/stellar/verify — signed challenge, completes the wallet login
    exercised.push("POST /auth/stellar/verify");
    await assertContract(
      "POST",
      "/auth/stellar/verify",
      await apiFetch(
        `${baseUrl}/auth/stellar/verify`,
        jsonInit({
          publicKey: kp.publicKey(),
          challengeId,
          signature: kp.sign(Buffer.from(challengeMessage!)).toString("base64"),
        })
      )
    );

    // GET /auth/google/start — 503 google_oauth_not_configured without env
    exercised.push("GET /auth/google/start");
    await assertContract("GET", "/auth/google/start", await apiFetch(`${baseUrl}/auth/google/start`));

    // GET /auth/google/callback — 302 back to the web origin (redirect: manual)
    exercised.push("GET /auth/google/callback");
    await assertContract("GET", "/auth/google/callback", await apiFetch(`${baseUrl}/auth/google/callback`));

    // POST /auth/logout — 204, clears the cookie
    exercised.push("POST /auth/logout");
    await assertContract(
      "POST",
      "/auth/logout",
      await apiFetch(`${baseUrl}/auth/logout`, { method: "POST", headers: { Cookie: cookie } })
    );

    // No /auth/* route may be left unasserted.
    const authRoutes = ROUTES.filter((r) => r.path.startsWith("/auth/"));
    const unasserted = authRoutes
      .map((r) => `${r.method} ${r.path}`)
      .filter((k) => !exercised.includes(k));
    assert.deepEqual(unasserted, [], `auth routes with no success-path assertion:\n  ${unasserted.join("\n  ")}`);
  } finally {
    await close();
  }
});

test("every list route returns its documented top-level collection key", async () => {
  const { baseUrl, close, stores } = await startHarness(true);
  try {
    const listRoutes = ROUTES.filter((r) => r.list === true);

    for (const route of listRoutes) {
      const ids = await seedFixtures(stores);
      const probe = route.sample ? route.sample(ids) : { path: route.path };

      const res = await apiFetch(`${baseUrl}${probe.path}`, probe.init);
      assert.equal(res.status, 200, `${route.method} ${route.path} list probe must be 200`);
      const body = await res.json();
      assert.ok(Array.isArray(body[collectionKeyOf(route)]), `${route.path} must return an array`);
    }
  } finally {
    await close();
  }
});

function collectionKeyOf(route: RouteContract): string {
  const key = route.keys?.find((k) =>
    ["agents", "activity", "approvals", "executions", "schedules"].includes(k)
  );
  return key ?? "";
}

test("unknown path returns 404 with an error body", async () => {
  const { baseUrl, close } = await startHarness();
  try {
    const res = await apiFetch(`${baseUrl}/this/route/does/not/exist`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error, "404 body must carry an error field");
  } finally {
    await close();
  }
});

test("known path with an unsupported method returns 404", async () => {
  const { baseUrl, close } = await startHarness();
  try {
    // /agents exists for GET; DELETE is not dispatched, so it must fall
    // through to the 404 fallback rather than silently succeeding.
    const res = await apiFetch(`${baseUrl}/agents`, { method: "DELETE" });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error, "404 body must carry an error field");
  } finally {
    await close();
  }
});

test("OPTIONS preflight returns 204 without authentication", async () => {
  const { baseUrl, close } = await startHarness();
  try {
    const res = await apiFetch(`${baseUrl}/agents`, { method: "OPTIONS" });
    assert.equal(res.status, 204);
  } finally {
    await close();
  }
});

test("unknown /auth/* route returns 404, not 401", async () => {
  const { baseUrl, close } = await startHarness();
  try {
    const res = await apiFetch(`${baseUrl}/auth/nope`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error, "404 body must carry an error field");
  } finally {
    await close();
  }
});
