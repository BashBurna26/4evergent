import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { clearAgents } from "../src/index.js";
import { AgentScheduler } from "../src/scheduler.js";
import { InMemoryScheduleStore } from "@4evergent/database";
import type { ScheduleRecord } from "@4evergent/database";
import crypto from "node:crypto";
import { startServer, apiFetch } from "./helpers.js";

function makeSchedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    agentId: "test-agent",
    ownerId: "test",
    status: "active",
    intent: {
      type: "payment",
      asset: "XLM",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "10",
      reason: "test schedule",
    },
    scheduleExpression: "0 * * * *",
    timezone: "UTC",
    nextRunAt: "2099-01-01T00:00:00Z",
    lastRunAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// Local helpers removed — provided by the shared harness (issue #86).
// The previous local `startServer(scheduleStore?, registerAgent = true)`
// maps to `startServer({ scheduleStore, registerAgent, policyRules, deferExecution })`.

async function patchSchedule(baseUrl: string, agentId: string, scheduleId: string, body: unknown) {
  const res = await apiFetch(`${baseUrl}/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

async function _getSchedule(baseUrl: string, scheduleId: string) {
  const res = await apiFetch(`${baseUrl}/agents/test-agent/schedules/${encodeURIComponent(scheduleId)}`);
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  clearAgents();
});

// ===== TEST 1: VALID UPDATE =====
test("PATCH /agents/:id/schedules/:id — valid update returns 200 and updated schedule", async () => {
  const store = new InMemoryScheduleStore();
  const schedule = makeSchedule({ scheduleExpression: "0 * * * *" });
  await store.create(schedule);

  const { baseUrl, close } = await startServer({ scheduleStore: store, policyRules: { maxTxAmount: { XLM: "1000" } }, deferExecution: true });

  try {
    const res = await patchSchedule(baseUrl, "test-agent", schedule.id, { scheduleExpression: "*/5 * * * *" });
    assert.equal(res.status, 200);
    assert.equal(res.body.schedule.id, schedule.id);
    assert.equal(res.body.schedule.agentId, "test-agent");
    assert.equal(res.body.schedule.ownerId, "test");
    assert.equal(res.body.schedule.scheduleExpression, "*/5 * * * *");
    assert.ok(res.body.schedule.nextRunAt !== schedule.nextRunAt);
  } finally {
    await close();
  }
});

// ===== TEST 2: INVALID SCHEDULE EXPRESSION =====
test("PATCH /agents/:id/schedules/:id — invalid cron expression returns 400 and does not mutate", async () => {
  const store = new InMemoryScheduleStore();
  const schedule = makeSchedule({ scheduleExpression: "0 * * * *" });
  await store.create(schedule);

  const { baseUrl, close, scheduleStore } = await startServer({ scheduleStore: store, policyRules: { maxTxAmount: { XLM: "1000" } }, deferExecution: true });

  try {
    const res = await patchSchedule(baseUrl, "test-agent", schedule.id, { scheduleExpression: "invalid" });
    assert.equal(res.status, 400);

    const after = await scheduleStore.get(schedule.id);
    assert.equal(after?.scheduleExpression, "0 * * * *");
    assert.equal(after?.updatedAt, schedule.updatedAt);
  } finally {
    await close();
  }
});

// ===== TEST 3: NONEXISTENT SCHEDULE =====
test("PATCH /agents/:id/schedules/:id — nonexistent schedule returns 404", async () => {
  const { baseUrl, close } = await startServer();

  try {
    const res = await patchSchedule(baseUrl, "test-agent", "nonexistent-id", { scheduleExpression: "*/5 * * * *" });
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

// ===== TEST 4: CROSS-OWNER ISOLATION =====
test("PATCH /agents/:id/schedules/:id — cross-owner update returns 404 and does not mutate", async () => {
  // Owner B's schedule
  const storeB = new InMemoryScheduleStore();
  const scheduleB = makeSchedule({ id: "sched-b", agentId: "agent-b", ownerId: "owner-b" });
  await storeB.create(scheduleB);

  // Server authenticated as owner-a but with owner-b's schedule store
  // Owner A does NOT have access to agent-b
  const { baseUrl, close, scheduleStore } = await startServer({ scheduleStore: storeB, policyRules: { maxTxAmount: { XLM: "1000" } }, deferExecution: true });

  try {
    // Owner A attempts to PATCH owner B's schedule via agent-b path
    const res = await patchSchedule(baseUrl, "agent-b", "sched-b", { scheduleExpression: "*/5 * * * *" });
    assert.equal(res.status, 404);

    // Verify owner B's schedule was not mutated
    const after = await scheduleStore.get("sched-b");
    assert.equal(after?.scheduleExpression, "0 * * * *");
    assert.equal(after?.ownerId, "owner-b");
  } finally {
    await close();
  }
});

// ===== TEST 5: AGENT ID IN URL DOES NOT RESTRICT OWNER'S ACCESS =====
// The authorization model is schedule-owner-based: if you own the schedule,
// the agentId in the URL path does not restrict access. This documents the
// actual contract — the handler checks schedule.ownerId, not agent ownership.
test("PATCH /agents/:id/schedules/:id — owner can update own schedule regardless of URL agentId", async () => {
  const store = new InMemoryScheduleStore();
  const schedule = makeSchedule({ agentId: "test-agent", ownerId: "test" });
  await store.create(schedule);

  const { baseUrl, close, scheduleStore } = await startServer({ scheduleStore: store, policyRules: { maxTxAmount: { XLM: "1000" } }, deferExecution: true });

  try {
    // URL uses "some-other-agent" (not registered), but the schedule is owned by "test"
    const res = await patchSchedule(baseUrl, "some-other-agent", schedule.id, { scheduleExpression: "*/5 * * * *" });
    assert.equal(res.status, 200);

    const after = await scheduleStore.get(schedule.id);
    assert.equal(after?.scheduleExpression, "*/5 * * * *");
  } finally {
    await close();
  }
});

// ===== TEST 6: nextRunAt RECALCULATION =====
test("PATCH /agents/:id/schedules/:id — nextRunAt recalculated with new expression", async () => {
  const store = new InMemoryScheduleStore();
  const schedule = makeSchedule({ scheduleExpression: "0 0 * * *", nextRunAt: "2099-01-01T00:00:00Z" });
  await store.create(schedule);

  const { baseUrl, close, scheduleStore } = await startServer({ scheduleStore: store, policyRules: { maxTxAmount: { XLM: "1000" } }, deferExecution: true });

  try {
    const res = await patchSchedule(baseUrl, "test-agent", schedule.id, { scheduleExpression: "0 * * * *" });
    assert.equal(res.status, 200);

    const after = await scheduleStore.get(schedule.id);
    assert.ok(after);
    assert.notEqual(after!.nextRunAt, schedule.nextRunAt);
    assert.ok(after!.nextRunAt !== "2099-01-01T00:00:00Z");
  } finally {
    await close();
  }
});

// ===== TEST 7: IMMUTABLE FIELDS PRESERVED =====
test("PATCH /agents/:id/schedules/:id — id, agentId, ownerId, intent, timezone are preserved", async () => {
  const store = new InMemoryScheduleStore();
  const schedule = makeSchedule({
    scheduleExpression: "0 * * * *",
    timezone: "UTC",
    intent: {
      type: "payment",
      asset: "USDC",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "100",
      reason: "immutable test",
    },
  });
  await store.create(schedule);

  const { baseUrl, close, scheduleStore } = await startServer({ scheduleStore: store, policyRules: { maxTxAmount: { XLM: "1000" } }, deferExecution: true });

  try {
    const res = await patchSchedule(baseUrl, "test-agent", schedule.id, { scheduleExpression: "*/5 * * * *" });
    assert.equal(res.status, 200);

    const after = await scheduleStore.get(schedule.id);
    assert.equal(after!.id, schedule.id);
    assert.equal(after!.agentId, schedule.agentId);
    assert.equal(after!.ownerId, schedule.ownerId);
    assert.equal(after!.intent.type, "payment");
    assert.equal(after!.intent.asset, "USDC");
    assert.equal(after!.intent.amount, "100");
    assert.equal(after!.timezone, "UTC");
  } finally {
    await close();
  }
});

// ===== TEST 8: INVALID BODY (empty expression) =====
test("PATCH /agents/:id/schedules/:id — empty scheduleExpression returns 400", async () => {
  const store = new InMemoryScheduleStore();
  const schedule = makeSchedule();
  await store.create(schedule);

  const { baseUrl, close, scheduleStore } = await startServer({ scheduleStore: store, policyRules: { maxTxAmount: { XLM: "1000" } }, deferExecution: true });

  try {
    const res = await patchSchedule(baseUrl, "test-agent", schedule.id, { scheduleExpression: "" });
    assert.equal(res.status, 400);

    const after = await scheduleStore.get(schedule.id);
    assert.equal(after?.scheduleExpression, schedule.scheduleExpression);
  } finally {
    await close();
  }
});

// ===== TEST 9: PATCH WITHOUT scheduleExpression FIELD =====
test("PATCH /agents/:id/schedules/:id — patch without scheduleExpression returns 200 without mutating", async () => {
  const store = new InMemoryScheduleStore();
  const schedule = makeSchedule({ scheduleExpression: "0 * * * *" });
  await store.create(schedule);

  const { baseUrl, close } = await startServer({ scheduleStore: store, policyRules: { maxTxAmount: { XLM: "1000" } }, deferExecution: true });

  try {
    const res = await patchSchedule(baseUrl, "test-agent", schedule.id, {});
    assert.equal(res.status, 200);
    assert.equal(res.body.schedule.scheduleExpression, "0 * * * *");
  } finally {
    await close();
  }
});

// ===== TEST 10: NO SECRET EXPOSURE =====
test("PATCH /agents/:id/schedules/:id — response does not contain secret fields", async () => {
  const store = new InMemoryScheduleStore();
  const schedule = makeSchedule();
  await store.create(schedule);

  const { baseUrl, close } = await startServer({ scheduleStore: store, policyRules: { maxTxAmount: { XLM: "1000" } }, deferExecution: true });

  try {
    const res = await patchSchedule(baseUrl, "test-agent", schedule.id, { scheduleExpression: "*/5 * * * *" });
    const json = JSON.stringify(res.body);
    assert.ok(!/secret|seed|private_key|mnemonic|keypair/i.test(json));
  } finally {
    await close();
  }
});

// ===== TEST 11: PATCH → SCHEDULER INTEGRATION =====
// End-to-end proof that editing a schedule expression changes WHEN the
// scheduler runs it. The PATCH handler recalculates nextRunAt from the NEW
// expression; the scheduler then reads that persisted nextRunAt from the
// store to decide due/not-due. No manual nextRunAt injection.
test("PATCH scheduleExpression → scheduler runs at NEW time, not old", async () => {
  const store = new InMemoryScheduleStore();
  // Initial expression: every hour at minute 0. nextRunAt far in the past so
  // it would be due immediately under the OLD expression.
  // Keep the legacy occurrence within the scheduler's lateness grace window,
  // so this test remains about schedule edits rather than missed-run policy.
  const oldNextRun = new Date(Date.now() - 60_000).toISOString();
  const schedule = makeSchedule({
    scheduleExpression: "0 * * * *",
    nextRunAt: oldNextRun,
  });
  await store.create(schedule);

  const { baseUrl, close } = await startServer({ scheduleStore: store, policyRules: { maxTxAmount: { XLM: "1000" } }, deferExecution: true });

  const executed: string[] = [];
  const scheduler = new AgentScheduler(
    store,
    { get: async (id: string) => (id === "test-agent" ? { id, status: "active", ownerId: "test" } : null) },
    async (s) => {
      executed.push(s.id);
      return { status: "submitted" } as any;
    }
  );

  try {
    // --- Step 1: BEFORE PATCH — schedule is due under OLD expression ---
    // old nextRunAt (2020) <= now, so scheduler WOULD execute it.
    const beforePatch = await scheduler.runDue(new Date().toISOString());
    assert.equal(beforePatch, 1, "schedule should be due under old expression");
    assert.equal(executed.length, 1, "schedule should have executed once before PATCH");

    // After a run, scheduler sets lastRunAt and recalculates nextRunAt from
    // the OLD expression ("0 * * * *" → next hour boundary, in the future).
    const afterFirstRun = await store.get(schedule.id);
    assert.ok(afterFirstRun, "schedule should exist after first run");
    assert.ok(new Date(afterFirstRun!.nextRunAt) > new Date(), "nextRunAt should now be in the future (old expression, already ran)");
    assert.ok(afterFirstRun!.lastRunAt, "lastRunAt should be set after first run");

    // --- Step 2: PATCH via the production handler ---
    // New expression: at minute 30 of each hour. This cannot coincide with
    // the old expression's top-of-hour occurrence, unlike an every-minute
    // schedule when the test happens to run just before the hour.
    const res = await patchSchedule(baseUrl, "test-agent", schedule.id, { scheduleExpression: "30 * * * *" });
    assert.equal(res.status, 200);
    assert.equal(res.body.schedule.scheduleExpression, "30 * * * *");

    // --- Step 3: Verify production logic recalculated nextRunAt ---
    // The PATCH handler computed this from the NEW expression — no manual injection.
    const patched = await store.get(schedule.id);
    assert.ok(patched, "schedule should exist after PATCH");
    assert.equal(patched!.scheduleExpression, "30 * * * *");
    assert.notEqual(patched!.nextRunAt, afterFirstRun!.nextRunAt, "nextRunAt must differ after PATCH (recalculated from new expression)");
    // New expression fires at the next half-hour boundary, within an hour.
    const drift = new Date(patched!.nextRunAt).getTime() - Date.now();
    assert.ok(drift > 0 && drift <= 60 * 60_000, `nextRunAt should be within an hour in the future (got ${drift}ms)`);

    // --- Step 4: Scheduler uses the NEW persisted nextRunAt ---
    // Time just BEFORE the new nextRunAt → schedule must NOT be due.
    const justBefore = new Date(new Date(patched!.nextRunAt).getTime() - 1000);
    const beforeDue = await scheduler.runDue(justBefore.toISOString());
    assert.equal(beforeDue, 0, "schedule must NOT execute before new nextRunAt");
    assert.equal(executed.length, 1, "still only the pre-PATCH execution");

    // Time AT/AFTER the new nextRunAt → schedule MUST be due.
    const atDue = new Date(patched!.nextRunAt);
    const afterDue = await scheduler.runDue(atDue.toISOString());
    assert.equal(afterDue, 1, "schedule MUST execute once new nextRunAt is reached");
    assert.equal(executed.length, 2, "schedule executed a second time at new time");

    // --- Step 5: execution is for the right schedule/agent ---
    assert.equal(executed[0], schedule.id);
    assert.equal(executed[1], schedule.id);
  } finally {
    await close();
  }
});
