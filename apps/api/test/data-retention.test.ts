import { test } from "node:test";
import assert from "node:assert/strict";
import { sweepRetainedData } from "../src/data-retention.js";

test("Data retention: a zero-day window keeps both tables forever", async () => {
  let sessionsSwept = 0;
  let spendingSwept = 0;
  const result = await sweepRetainedData({
    store: { sweepDailySpending: async () => { spendingSwept++; return 0; } },
    authModule: { sweepExpiredSessions: () => { sessionsSwept++; return 0; } },
    now: Date.parse("2026-01-15T12:00:00.000Z"),
    authSessionDays: 0,
    dailySpendingDays: 0,
  });

  assert.deepEqual(result, { authSessionsRemoved: 0, dailySpendingRemoved: 0 });
  assert.equal(sessionsSwept, 0);
  assert.equal(spendingSwept, 0);
});

test("Data retention: sweeps use the configured age cutoffs", async () => {
  let sessionCutoff = 0;
  let spendingCutoff = "";
  const now = Date.parse("2026-01-15T12:00:00.000Z");
  const result = await sweepRetainedData({
    store: { sweepDailySpending: async (cutoff) => { spendingCutoff = cutoff; return 2; } },
    authModule: { sweepExpiredSessions: (cutoff) => { sessionCutoff = cutoff; return 1; } },
    now,
    authSessionDays: 30,
    dailySpendingDays: 90,
  });

  assert.deepEqual(result, { authSessionsRemoved: 1, dailySpendingRemoved: 2 });
  assert.equal(sessionCutoff, now - 30 * 24 * 60 * 60_000);
  assert.equal(spendingCutoff, "2025-10-17");
});
