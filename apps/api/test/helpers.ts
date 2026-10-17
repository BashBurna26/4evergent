import type { AddressInfo } from "node:net";
import { createApiServer } from "../src/index.js";
import { DevAuthProvider } from "@4evergent/shared";
import {
  InMemoryActivityStore,
  InMemoryExecutionStore,
  InMemoryScheduleStore,
  InMemoryApprovalStore,
} from "@4evergent/database";
import type {
  ActivityStore,
  ExecutionStore,
  ScheduleStore,
  ApprovalStore,
} from "@4evergent/database";
import type { Signer } from "@4evergent/stellar";
import type { AuthProvider, PolicyRules } from "@4evergent/shared";

/**
 * Shared test harness for the API test suite (issue #86).
 *
 * Consolidates the 15 duplicated `startServer` helpers (12 distinct
 * signatures) into one superset. Each option maps to a capability at least one
 * of the pre-existing variants needed:
 *
 * | Option         | Variants that needed it                                        |
 * |----------------|----------------------------------------------------------------|
 * | policyRules    | approval-integration, authorization, idempotency, integration,  |
 * |                | policy-config, read-endpoints, schedule-update, schedule-activity |
 * | authProvider   | agent-lifecycle, authorization, cors, direct-path-sequence      |
 * | signer         | approval-integration, direct-path-sequence, idempotency,        |
 * |                | integration, policy-config, sequence-coordinator-integration    |
 * | ownerId        | direct-path-sequence, idempotency, policy-config                |
 * | agentId        | dashboard-endpoints, idempotency, policy-config                 |
 * | registerAgent  | dashboard-endpoints, read-endpoints, schedule-update            |
 * | deferExecution | approval-integration, schedule-update, schedule-activity-link   |
 * | intervalMs     | schedule-activity-link, sequence-coordinator-integration        |
 * | scheduleStore  | schedule-update, schedule-activity-link                         |
 *
 * Not yet supported (follow-up scope): `dbPath` / SQLite-backed stores — no
 * existing variant used them, so the harness keeps the in-memory stores only.
 *
 * `TestServer` exposes the union of what the 15 copies returned: `baseUrl`,
 * `close`, plus the in-memory stores so tests can assert on server-side state.
 */

export interface TestServerOptions {
  policyRules?: Partial<PolicyRules>;
  authProvider?: AuthProvider;
  signer?: Signer;
  ownerId?: string;
  agentId?: string;
  /** Register the default test agent (default: true). */
  registerAgent?: boolean;
  deferExecution?: boolean;
  /** Scheduler + execution queue interval (default: 100ms). */
  intervalMs?: number;
  scheduleStore?: ScheduleStore;
  /** Enable the background scheduler and execution queue (default: false). */
  schedulerEnabled?: boolean;
  /** Register a custom agent record instead of the default test agent. */
  agent?: TestAgent;
}

/** Shape of the agent record `server.registerAgent` accepts. */
export type TestAgent = Parameters<
  Awaited<ReturnType<typeof createApiServer>>["registerAgent"]
>[0];

export interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
  activityStore: ActivityStore;
  executionStore: ExecutionStore;
  scheduleStore: ScheduleStore;
  approvalStore: ApprovalStore;
  server: Awaited<ReturnType<typeof createApiServer>>;
}

/** Default signer used when the caller does not inject one. */
export class MockSigner implements Signer {
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
    transaction.signatures = [
      { hint: Buffer.from("mock"), signature: Buffer.from("sig") },
    ];
    return transaction;
  }
}

export const DEFAULT_TEST_AGENT = {
  id: "test-agent",
  displayName: "Test Agent",
  description: "test agent",
  ownerId: "test",
  stellarAddress: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  capabilities: ["payment"],
  status: "active" as const,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  active: true,
  metadata: {},
};

/**
 * Start a test API server on an ephemeral port.
 *
 * Defaults mirror what the majority of the pre-existing helpers did:
 * in-memory stores, a MockSigner, a DevAuthProvider, and the test agent
 * registered. Pass options to opt into the divergent behaviours.
 */
export async function startServer(
  opts: TestServerOptions = {}
): Promise<TestServer> {
  const signer = opts.signer ?? new MockSigner("test-agent");
  const ownerId = opts.ownerId ?? "test";
  const agentId = opts.agentId ?? "test-agent";

  const activityStore = new InMemoryActivityStore();
  const executionStore = new InMemoryExecutionStore();
  const approvalStore = new InMemoryApprovalStore();
  const scheduleStore = opts.scheduleStore ?? new InMemoryScheduleStore();

  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer,
    policyRules: opts.policyRules,
    deferExecution: opts.deferExecution,
    authProvider:
      opts.authProvider ?? new DevAuthProvider({ defaultOwnerId: ownerId }),
    activityStore,
    executionStore,
    approvalStore,
    scheduleStore,
    scheduler: opts.schedulerEnabled
      ? { enabled: true, intervalMs: opts.intervalMs ?? 100 }
      : undefined,
    executionQueue: opts.schedulerEnabled
      ? { enabled: true, intervalMs: opts.intervalMs ?? 100 }
      : undefined,
  });

  if (opts.registerAgent !== false) {
    server.registerAgent(
      opts.agent ?? { ...DEFAULT_TEST_AGENT, id: agentId, ownerId }
    );
  }

  return new Promise<TestServer>((resolve) => {
    const http = server.server.listen(0, "127.0.0.1", () => {
      const addr = http.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
        activityStore,
        executionStore,
        scheduleStore,
        approvalStore,
        server,
      });
    });
  });
}

/** Fetch wrapper matching the previous local helpers (keepalive off). */
export function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, keepalive: false });
}

/** Sleep for n ms on the event loop. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll an async predicate until truthy or timeout. */
export async function waitFor<T>(
  fn: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 2000,
  intervalMs = 20
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(intervalMs);
  }
  return await fn();
}
