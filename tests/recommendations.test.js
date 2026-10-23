"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { recommendAccounts } = require("../lib/recommendations");
const now = Date.now();
function row(id, priority, remaining, extra = {}) {
  return { id, provider: "openai-codex", priority, source: "plugin", status: "ok",
    windows: remaining.map((remainingPercent) => ({ remainingPercent })), ...extra };
}
test("recommends first available account by vendor priority, not the largest quota", () => {
  const input = [row("b", 2, [90]), row("a", 1, [5]), row("claude", 1, [50], { provider: "anthropic" })];
  const result = recommendAccounts(input, now);
  assert.deepEqual(result.map((a) => a.recommended), [false, true, true]);
  assert.equal(input[0].recommended, undefined);
});
test("exhausted, failed, empty, malformed and expired windows are not recommended", () => {
  const result = recommendAccounts([
    row("exhausted", 1, [90, 0]), row("error", 2, [80], { status: "error" }), row("empty", 3, []),
    row("missing", 4, [null]), row("nan", 5, [NaN]), row("invalid", 6, [101]),
    row("expired", 7, [], { windows: [{ remainingPercent: 80, resetsAt: new Date(now).toISOString() }] }),
    row("invalid-reset", 8, [], { windows: [{ remainingPercent: 80, resetsAt: "invalid" }] }),
  ], now);
  assert.equal(result[0].availability, "exhausted");
  assert.ok(result.slice(1).every((r) => r.availability === "unknown"));
  assert.ok(result.every((r) => r.recommended === false));
});
test("cached recommendation loses validity once its quota reset passes", () => {
  const initial = recommendAccounts([row("a", 1, [], { windows: [{ remainingPercent: 70, resetsAt: new Date(now + 1000).toISOString() }] }), row("b", 2, [20])], now);
  assert.equal(initial[0].recommended, true);
  const later = recommendAccounts(initial, now + 1001);
  assert.equal(later[0].availability, "unknown");
  assert.equal(later[0].recommended, false);
  assert.equal(later[1].recommended, true);
});
test("CLI and manual sources do not participate in OAuth account recommendation", () => {
  const result = recommendAccounts([row("cli", 1, [100], { source: "cli" }), row("manual", 1, [100], { source: "settings" }), row("plugin", 2, [10])]);
  assert.equal(result[0].recommended, undefined);
  assert.equal(result[1].recommended, undefined);
  assert.equal(result[2].recommended, true);
});
