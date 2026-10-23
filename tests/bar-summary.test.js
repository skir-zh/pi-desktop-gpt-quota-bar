"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const file = path.resolve(__dirname, "../main.js");
const actualRequire = createRequire(file);
const code = fs.readFileSync(file, "utf8");

function app(settings = {}, { weekly = 58, primary = true, vendor = "openai-codex", fetcher, clock } = {}) {
  const requests = [];
  const forbidden = [];
  const auth = {
    listAccounts: async () => [{ id: "one", vendor, priority: 1 }],
    credential: async () => ({ token: "secret-token", source: "plugin" }),
  };
  const pi = {
    plugin: { getSettings: async () => ({ autoDetect: false, ...settings }) },
    app: { getAppearance: async () => ({ locale: "zh-CN" }) },
    net: { fetch: async (input) => {
      requests.push(input);
      if (fetcher) return fetcher(input);
      return { status: 200, bodyText: JSON.stringify({ rate_limit: {
        ...(primary ? { primary_window: { used_percent: 24, limit_window_seconds: 18000 } } : {}),
        secondary_window: { used_percent: 100 - weekly, limit_window_seconds: 604800 },
      } }) };
    } },
    // Real host: getLlmContext requires session.read AND an in-flight plugin tool.
    session: { getLlmContext: () => {
      forbidden.push("session.getLlmContext");
      throw Object.assign(new Error("session context is only available during tool execution"), { code: "INVALID_ARGUMENT" });
    } },
    models: { list: () => {
      forbidden.push("models.list");
      throw Object.assign(new Error("permission denied"), { code: "PERMISSION_DENIED" });
    } },
  };
  const sandbox = { pi, module: { exports: {} }, Buffer, console,
    ...(clock ? { Date: clock } : {}),
    require(name) {
      if (name === "./lib/oauth") return { createAuth: () => auth };
      if (name === "node:fs/promises") return { stat: async () => { throw new Error("no CLI"); } };
      return actualRequire(name);
    }, process: { env: {} },
  };
  vm.runInNewContext(code, sandbox, { filename: file });
  return { plugin: sandbox.module.exports, settings, requests, forbidden };
}

async function warmed(fixture) {
  const snapshot = await fixture.plugin.onRendererCall("quota.refresh", {});
  assert.equal(snapshot.ok, true);
  return fixture.plugin.onRendererCall("quota.summary", {});
}

test("idle toolbar works with the real host's tool-only session contract", async () => {
  const fixture = app();
  const summary = await warmed(fixture);
  assert.equal(summary.state, "ready");
  assert.equal(summary.account.vendor, "openai-codex");
  assert.equal(summary.windows.length, 1);
  assert.equal(summary.windows[0].period, "session");
  assert.equal(summary.windows[0].remainingPercent, 76);
  assert.deepEqual(fixture.forbidden, [], "toolbar must never call tool-only or undeclared APIs");
  assert.ok(!JSON.stringify(summary).includes("secret-token"));
});

for (const weekly of [10, 10.1, 91]) {
  test(`default threshold hides weekly remaining ${weekly}%`, async () => {
    const summary = await warmed(app({}, { weekly }));
    assert.equal(summary.windows.length, 1);
  });
}
for (const weekly of [0, 9.9]) {
  test(`default threshold appends weekly remaining ${weekly}%`, async () => {
    const summary = await warmed(app({}, { weekly }));
    assert.deepEqual(Array.from(summary.windows, (item) => item.period), ["session", "week"]);
    assert.equal(summary.windows[1].remainingPercent, weekly);
  });
}

test("settings change applies to cached quota without additional network requests", async () => {
  const settings = { weeklyShowBelowPercent: 10 };
  const fixture = app(settings, { weekly: 20 });
  assert.equal((await warmed(fixture)).windows.length, 1);
  const requests = fixture.requests.length;
  settings.weeklyShowBelowPercent = 25;
  assert.equal((await fixture.plugin.onRendererCall("quota.summary", {})).windows.length, 2);
  settings.weeklyShowBelowPercent = 0;
  assert.equal((await fixture.plugin.onRendererCall("quota.summary", {})).windows.length, 1);
  assert.equal(fixture.requests.length, requests);
});

test("missing 5h window falls back to weekly without duplication", async () => {
  const summary = await warmed(app({}, { weekly: 9, primary: false }));
  assert.equal(summary.windows.length, 1);
  assert.equal(summary.windows[0].period, "week");
});

test("a GPT toolbar must not substitute another vendor's quota", async () => {
  const fixture = app({ demoMode: true });
  const summary = await warmed(fixture);
  assert.equal(summary.account.vendor, "openai-codex");
});

test("the source no longer contains restricted model lookups", () => {
  assert.doesNotMatch(code, /pi\.session\.|pi\.models\./);
});

test("manifest exposes the default threshold without new model or session permissions", () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../manifest.json"), "utf8"));
  const setting = manifest.contributes.settings.find((item) => item.key === "weeklyShowBelowPercent");
  assert.equal(setting.type, "number");
  assert.equal(setting.default, 10);
  assert.equal(manifest.permissions.some((permission) => /session|models/.test(permission)), false);
});

test("unified reads share one in-flight collection and return one consistent revision", async () => {
  let release, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const f = app({}, { fetcher: async () => {
    entered();
    await gate;
    return { status: 200, bodyText: JSON.stringify({ rate_limit: {
      primary_window: { used_percent: 53, limit_window_seconds: 18000 },
    } }) };
  } });
  const first = f.plugin.onRendererCall("quota.read", { force: true });
  await started;
  const second = f.plugin.onRendererCall("quota.read", { force: true });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(f.requests.length, 1);
  for (const value of [a, b]) {
    assert.equal(value.revision, value.snapshot.revision);
    assert.equal(value.summary.windows[0].remainingPercent, 47);
    assert.equal(value.snapshot.accounts[0].windows[0].remainingPercent, 47);
    assert.equal(value.summary.updatedAt, value.snapshot.generatedAt);
  }
  assert.equal(a.revision, b.revision);
  const cached = await f.plugin.onRendererCall("quota.read", {});
  assert.equal(cached.revision, a.revision);
  assert.equal(f.requests.length, 1);
});

test("expired cache is refreshed before unified read returns, not one poll later", async () => {
  let time = Date.UTC(2026, 9, 19), remaining = 53;
  class Clock extends Date { static now() { return time; } }
  const f = app({ refreshSeconds: 60 }, { clock: Clock, fetcher: async () => ({
    status: 200, bodyText: JSON.stringify({ rate_limit: {
      primary_window: { used_percent: 100 - remaining, limit_window_seconds: 18000 },
    } }),
  }) });
  const a = await f.plugin.onRendererCall("quota.read", {});
  remaining = 47;
  time += 60_001;
  const b = await f.plugin.onRendererCall("quota.read", {});
  assert.equal(f.requests.length, 2);
  assert.ok(b.revision > a.revision);
  assert.equal(b.summary.windows[0].remainingPercent, 47);
  assert.equal(b.snapshot.accounts[0].windows[0].remainingPercent, 47);
});

test("a failed collection releases the shared request and a forced retry recovers", async () => {
  let failed = true;
  const f = app({}, { fetcher: async () => {
    if (failed) throw new Error("offline");
    return { status: 200, bodyText: JSON.stringify({ rate_limit: {
      primary_window: { used_percent: 53, limit_window_seconds: 18000 },
    } }) };
  } });
  const first = await f.plugin.onRendererCall("quota.read", { force: true });
  assert.equal(first.snapshot.accounts[0].status, "error");
  failed = false;
  const second = await f.plugin.onRendererCall("quota.read", { force: true });
  assert.ok(second.revision > first.revision);
  assert.equal(second.summary.windows[0].remainingPercent, 47);
  assert.equal(second.snapshot.accounts[0].windows[0].remainingPercent, 47);
  assert.equal(f.requests.length, 2);
});

for (const refreshSeconds of [30, 300, 3600]) {
  test(`all snapshot readers respect the configured ${refreshSeconds}s cache`, async () => {
    let time = Date.UTC(2026, 9, 19);
    class Clock extends Date { static now() { return time; } }
    const f = app({ refreshSeconds }, { clock: Clock });
    await f.plugin.onRendererCall("quota.read", {});
    time += refreshSeconds * 1000 - 1;
    await f.plugin.onRendererCall("quota.read", {});
    await f.plugin.onRendererCall("quota.snapshot", {});
    await f.plugin.onRendererCall("quota.summary", {});
    assert.equal(f.requests.length, 1);
    time += 1;
    await f.plugin.onRendererCall("quota.read", {});
    assert.equal(f.requests.length, 2);
    await f.plugin.onRendererCall("quota.read", { force: true });
    assert.equal(f.requests.length, 3, "explicit refresh bypasses the cache");
  });
}
