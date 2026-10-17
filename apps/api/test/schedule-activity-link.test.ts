import { test } from "node:test";
import assert from "node:assert/strict";
import type { ScheduleRecord, ExecutionRecord } from "@4evergent/database";
import crypto from "node:crypto";
import { startServer, waitFor } from "./helpers.js";

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
      reason: "scheduled payment test",
    },
    scheduleExpression: "0 * * * *",
    timezone: "UTC",
    nextRunAt: new Date(Date.now() - 60000).toISOString(),
    lastRunAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Find the first execution record for an agent with a given status (or any). */
function findExecution(records: ExecutionRecord[], status?: string): ExecutionRecord | undefined {
  if (status) return records.find((r) => r.status === status);
  return records.find((r) => r.activityId != null);
}

test("SCHEDULE ACTIVITY TEST 1: scheduler enqueues execution with linked ActivityRecord", async () => {
  const { close, executionStore, scheduleStore } = await startServer({ intervalMs: 50, schedulerEnabled: true, policyRules: { maxTxAmount: { XLM: "1000" } }, deferExecution: true });

  try {
    const schedule = makeSchedule();
    await scheduleStore.create(schedule);

    // Wait for the scheduler to fire and enqueue
    const execution = await waitFor(async () =>
      findExecution([...(await executionStore.listByAgent(schedule.agentId))])
    , 1000);

    assert.ok(execution, "ExecutionRecord with activityId should be enqueued by scheduler");
    assert.equal(execution!.agentId, "test-agent");
    assert.equal(execution!.ownerId, "test");
    assert.deepEqual(execution!.intent, schedule.intent);
    assert.ok(execution!.activityId, "ExecutionRecord.activityId must be non-null");
  } finally {
    await close();
  }
});

test("SCHEDULE ACTIVITY TEST 2: scheduler creates ActivityRecord before pipeline runs", async () => {
  const { close, activityStore, executionStore, scheduleStore } = await startServer({ intervalMs: 50, schedulerEnabled: true, policyRules: { maxTxAmount: { XLM: "1000" } }, deferExecution: true });

  try {
    const schedule = makeSchedule();
    await scheduleStore.create(schedule);

    // Wait for an execution record to appear (any status)
    await waitFor(async () => {
      const recs = await executionStore.listByAgent(schedule.agentId);
      return recs.length > 0 ? recs[0] : undefined;
    }, 1000);

    // The ActivityRecord should exist immediately after scheduler fires
    const activities = await activityStore.listByAgent(schedule.agentId);
    assert.ok(activities.length > 0, "At least one ActivityRecord should exist");

    const activity = activities[0];
    assert.equal(activity.agentId, "test-agent");
    assert.equal(activity.ownerId, "test");
    assert.deepEqual(activity.intent, schedule.intent);
    assert.equal(activity.status, "pending", "ActivityRecord should be pending before execution completes");
    assert.equal(activity.authorizationStatus, "not_required", "Scheduled execution bypasses approval");
  } finally {
    await close();
  }
});

test("SCHEDULE ACTIVITY TEST 3: ExecutionRecord.activityId links to ActivityRecord", async () => {
  const { close, activityStore, executionStore, scheduleStore } = await startServer({ intervalMs: 50, schedulerEnabled: true, policyRules: { maxTxAmount: { XLM: "1000" } }, deferExecution: true });

  try {
    const schedule = makeSchedule();
    await scheduleStore.create(schedule);

    // Wait for execution to be enqueued
    const execution = await waitFor(async () =>
      findExecution([...(await executionStore.listByAgent(schedule.agentId))])
    , 1000);

    assert.ok(execution, "ExecutionRecord should exist");
    assert.ok(execution!.activityId, "ExecutionRecord.activityId must be non-null");

    // Fetch the ActivityRecord by the linked ID
    const activity = await activityStore.get(execution!.activityId!);
    assert.ok(activity, "ActivityRecord referenced by execution must exist");
    assert.equal(activity!.id, execution!.activityId);
    assert.equal(activity!.agentId, schedule.agentId);
    assert.equal(activity!.ownerId, schedule.ownerId);
    assert.deepEqual(activity!.intent, schedule.intent);
  } finally {
    await close();
  }
});

test("SCHEDULE ACTIVITY TEST 4: no duplicate ActivityRecord after pipeline runs", async () => {
  const { close, activityStore, executionStore, scheduleStore } = await startServer({ intervalMs: 50, schedulerEnabled: true, policyRules: { maxTxAmount: { XLM: "1000" } }, deferExecution: true });

  try {
    const schedule = makeSchedule();
    await scheduleStore.create(schedule);

    // Wait for execution to reach a terminal state (Horizon network call takes ~6s)
    await waitFor(async () => {
      const recs = await executionStore.listByAgent(schedule.agentId);
      return findExecution(recs, "submitted") ?? findExecution(recs, "dead_letter") ?? findExecution(recs, "failed");
    }, 15000);

    // There should be exactly ONE ActivityRecord for this schedule's execution
    const allActivities = await activityStore.listByAgent(schedule.agentId);
    assert.equal(allActivities.length, 1, "Exactly one ActivityRecord should exist for the scheduled execution");

    // The activity should have been updated from "pending" to a terminal state
    const activity = allActivities[0];
    assert.notEqual(activity.status, "pending", "ActivityRecord should be updated to terminal state after pipeline runs");
  } finally {
    await close();
  }
});

test("SCHEDULE ACTIVITY TEST 5: owner isolation — activity belongs to schedule owner", async () => {
  const { close, activityStore, executionStore, scheduleStore } = await startServer({ intervalMs: 50, schedulerEnabled: true, policyRules: { maxTxAmount: { XLM: "1000" } }, deferExecution: true });

  try {
    const schedule = makeSchedule();
    await scheduleStore.create(schedule);

    // Wait for execution
    await waitFor(async () => {
      const recs = await executionStore.listByAgent(schedule.agentId);
      return findExecution(recs);
    }, 1000);

    // The ActivityRecord must belong to the same owner as the schedule
    const activities = await activityStore.listByAgent(schedule.agentId);
    assert.ok(activities.length > 0, "ActivityRecord should exist");
    for (const activity of activities) {
      assert.equal(activity.ownerId, schedule.ownerId, "ActivityRecord ownerId must match schedule ownerId");
    }

    // getForOwner should work for the legitimate owner
    const activity = await activityStore.getForOwner(activities[0]!.id, schedule.ownerId);
    assert.ok(activity, "Owner should be able to read their activity");

    // getForOwner should return null for a different owner
    const otherOwnerAccess = await activityStore.getForOwner(activities[0]!.id, "other-owner");
    assert.equal(otherOwnerAccess, null, "Cross-owner should not be able to read the activity");
  } finally {
    await close();
  }
});
