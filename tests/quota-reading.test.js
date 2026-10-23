"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const envelope = (revision, value) => ({ ok: true, revision,
  summary: { windows: [{ remainingPercent: value }] },
  snapshot: { accounts: [{ windows: [{ remainingPercent: value }] }] },
});

test("one commit owns both views and rejects late revisions and request sequences", async () => {
  const { acceptReading } = await import("../renderer/quota-reading.mjs");
  const current = acceptReading(null, envelope(3, 47), 5);
  assert.equal(current.summary.windows[0].remainingPercent, 47);
  assert.equal(current.snapshot.accounts[0].windows[0].remainingPercent, 47);
  assert.equal(acceptReading(current, envelope(2, 53), 10), current);
  assert.equal(acceptReading(current, envelope(3, 53), 4), current);
  const updated = acceptReading(current, envelope(3, 47), 6);
  assert.equal(updated.sequence, 6);
});

test("failed or partial responses cannot corrupt a consistent reading", async () => {
  const { acceptReading } = await import("../renderer/quota-reading.mjs");
  const current = acceptReading(null, envelope(1, 53), 1);
  for (const value of [null, { ok: false }, { revision: 2, summary: {} }, { summary: {}, snapshot: {} }]) {
    assert.equal(acceptReading(current, value, 2), current);
  }
  assert.equal(acceptReading(current, envelope(2, 47), 3).revision, 2);
});
