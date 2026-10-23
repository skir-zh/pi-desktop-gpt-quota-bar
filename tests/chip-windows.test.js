"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { selectChipWindows, weeklyThreshold } = require("../lib/chip-windows");
const now = Date.UTC(2026, 9, 19);
const session = { period: "session", remainingPercent: 77 };
const week = (remainingPercent, resetsAt) => ({ period: "week", remainingPercent, resetsAt });

test("threshold accepts 0..100 and rejects invalid configuration", () => {
  for (const value of [undefined, null, "", true, false, -1, 101, NaN, Infinity, "oops"]) {
    assert.equal(weeklyThreshold(value), 10);
  }
  for (const value of [0, 10, 25.5, 100]) assert.equal(weeklyThreshold(value), value);
});

test("expired, invalid or missing quota is never promoted as a low-week warning", () => {
  for (const item of [week(5, new Date(now).toISOString()), week(5, "invalid"), week(NaN), week(-1), week(101)]) {
    assert.deepEqual(selectChipWindows([session, item], 10, now), [session]);
  }
  assert.deepEqual(selectChipWindows([], 10, now), []);
});

test("current low weekly data is appended, zero threshold disables, and input is untouched", () => {
  const weekly = week(9, new Date(now + 3600_000).toISOString());
  const windows = [weekly, session];
  assert.deepEqual(selectChipWindows(windows, 10, now), [session, weekly]);
  assert.deepEqual(selectChipWindows(windows, 0, now), [session]);
  assert.deepEqual(windows, [weekly, session]);
});
