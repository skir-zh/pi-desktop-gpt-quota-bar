"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { JSON_SETTINGS, jsonTextPatch, createSettingsCompatibility } = require("../lib/settings-json");
const manifest = require("../manifest.json");
const definitions = manifest.contributes.settings;
const defaults = () => Object.fromEntries(definitions.map((setting) => [setting.key, setting.default]));

// Mirror PluginSettingsSheet: untouched fields retain their original values.
// On save the host JSON branch unconditionally parses String(value).
function hostSave(draft) {
  const payload = { ...draft };
  for (const setting of definitions) {
    if (setting.type === "json") payload[setting.key] = JSON.parse(String(payload[setting.key] ?? "{}"));
  }
  return payload;
}

function fixture(initial = {}) {
  const stored = { ...defaults(), ...initial };
  const events = new EventEmitter();
  const writes = [];
  const pi = {
    events,
    plugin: {
      getSettings: async () => ({ ...stored }),
      setSettings: async (patch) => { writes.push(patch); Object.assign(stored, patch); },
    },
  };
  return { stored, events, writes, pi, compatibility: createSettingsCompatibility(pi) };
}

test("baseline: old structured JSON defaults fail when changing only a number", () => {
  assert.throws(() => hostSave({ ...defaults(), credentials: {}, sources: [], accounts: [], refreshSeconds: 60 }));
});

test("fresh defaults and reset defaults can save unrelated numeric changes", () => {
  const draft = { ...defaults(), refreshSeconds: 60, weeklyShowBelowPercent: 90 };
  const saved = hostSave(draft);
  assert.deepEqual(saved.credentials, {});
  assert.equal(saved.refreshSeconds, 60);
  assert.equal(saved.weeklyShowBelowPercent, 90);
  for (const key of JSON_SETTINGS) assert.equal(typeof defaults()[key], "string");
});

test("upgrade preserves populated objects and arrays, including manual credentials", async () => {
  const original = {
    credentials: { "openai-codex": { token: "synthetic-token", accountId: "test-account" } },
    sources: [{ vendor: "xai", url: "https://api.x.ai/test" }],
    accounts: [{ label: "manual", windows: [{ period: "week", usedPercent: 20 }] }],
  };
  const f = fixture({ ...original, weeklyShowBelowPercent: 90 });
  await f.compatibility.start();
  for (const key of JSON_SETTINGS) assert.deepEqual(JSON.parse(f.stored[key]), original[key]);
  assert.equal(f.stored.weeklyShowBelowPercent, 90);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(Object.keys(f.writes[0]).sort(), JSON_SETTINGS.slice().sort());
  await f.compatibility.normalize();
  assert.equal(f.writes.length, 1, "normalization is idempotent");
  await f.compatibility.stop();
});

test("removed settings and unrelated legacy token entries are preserved, not normalized away", async () => {
  const sources = [{ vendor: "legacy-vendor", url: "https://example.com" }];
  const accounts = [{ label: "legacy manual quota" }];
  const credentials = { "openai-codex": "synthetic", "legacy-vendor": "untouched" };
  const f = fixture({ sources, accounts, credentials });
  await f.compatibility.start();
  assert.deepEqual(JSON.parse(f.stored.credentials), credentials);
  assert.equal(f.stored.sources, sources);
  assert.equal(f.stored.accounts, accounts);
  assert.deepEqual(Object.keys(f.writes[0]), ["credentials"]);
  await f.compatibility.stop();
});

test("save, close, reopen and save again remain compatible with the host JSON editor", async () => {
  const f = fixture();
  await f.compatibility.start();
  for (const threshold of [90, 10, 0]) {
    const draft = { ...f.stored, weeklyShowBelowPercent: threshold, refreshSeconds: 60 };
    const payload = hostSave(draft);
    Object.assign(f.stored, payload);
    f.events.emit("plugin:settingsChanged", payload);
    await f.compatibility.normalize();
    assert.equal(f.stored.weeklyShowBelowPercent, threshold);
    assert.equal(f.stored.refreshSeconds, 60);
    assert.doesNotThrow(() => hostSave({ ...f.stored }));
  }
  await f.compatibility.stop();
  assert.equal(f.events.listenerCount("plugin:settingsChanged"), 0);
});

test("invalid user JSON remains invalid and is not replaced with an empty object", async () => {
  const f = fixture({ credentials: '{"broken":' });
  await f.compatibility.start();
  assert.equal(f.stored.credentials, '{"broken":');
  assert.throws(() => hostSave(f.stored));
  assert.equal(f.writes.length, 0);
  await f.compatibility.stop();
});

test("stopping while a read is pending prevents late writes", async () => {
  let resolveRead;
  const events = new EventEmitter();
  const writes = [];
  const compatibility = createSettingsCompatibility({
    events,
    plugin: {
      getSettings: () => new Promise((resolve) => { resolveRead = resolve; }),
      setSettings: async (value) => writes.push(value),
    },
  });
  const loading = compatibility.start();
  await Promise.resolve();
  const stopping = compatibility.stop();
  resolveRead({ credentials: {} });
  await Promise.all([loading, stopping]);
  assert.equal(writes.length, 0);
  assert.equal(events.listenerCount("plugin:settingsChanged"), 0);
});

test("load failure unregisters the listener and preserves the original settings", async () => {
  const events = new EventEmitter();
  const original = { credentials: { test: "synthetic-token" } };
  const compatibility = createSettingsCompatibility({
    events,
    plugin: {
      getSettings: async () => original,
      setSettings: async () => { throw new Error("storage denied"); },
    },
  });
  await assert.rejects(compatibility.start(), /storage denied/);
  assert.equal(events.listenerCount("plugin:settingsChanged"), 0);
  assert.deepEqual(original, { credentials: { test: "synthetic-token" } });
  await compatibility.stop();
});

test("the plugin's real load/unload wiring enables settings compatibility", async () => {
  const f = fixture({ credentials: {}, sources: [], accounts: [], demoMode: true });
  const file = path.resolve(__dirname, "../main.js");
  const sandbox = { pi: f.pi, require: createRequire(file), module: { exports: {} }, Buffer, console, process: { env: {} } };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });
  await sandbox.module.exports.onLoad();
  assert.equal(f.events.listenerCount("plugin:settingsChanged"), 1);
  assert.doesNotThrow(() => hostSave({ ...f.stored, weeklyShowBelowPercent: 90 }));
  await sandbox.module.exports.onUnload();
  assert.equal(f.events.listenerCount("plugin:settingsChanged"), 0);
});

test("serialization failures do not include settings content", () => {
  const value = {};
  value.secret = value;
  assert.throws(() => jsonTextPatch({ credentials: value }), /^Error: Cannot serialize plugin JSON settings$/);
});

test("migrated JSON text still drives real quota collection without exposing tokens", async () => {
  const f = fixture({
    autoDetect: false,
    credentials: { "openai-codex": { token: "synthetic-token", accountId: "test-account" } },
    sources: [],
    accounts: [{ id: "manual", label: "Manual quota", windows: [{ period: "week", usedPercent: 25 }] }],
  });
  const requests = [];
  f.pi.net = { fetch: async (request) => {
    requests.push(request);
    return { status: 200, bodyText: JSON.stringify({ rate_limit: { primary_window: { used_percent: 23, limit_window_seconds: 18000 } } }) };
  } };
  const file = path.resolve(__dirname, "../main.js");
  const actualRequire = createRequire(file);
  const sandbox = { pi: f.pi, module: { exports: {} }, Buffer, console, process: { env: {} },
    require(name) {
      if (name === "./lib/oauth") return { createAuth: () => ({ listAccounts: async () => [], stop: async () => {} }) };
      return actualRequire(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });
  await sandbox.module.exports.onLoad();
  const snapshot = await sandbox.module.exports.onRendererCall("quota.refresh", {});
  const account = snapshot.accounts.find((item) => item.provider === "openai-codex");
  assert.equal(account.windows[0].remainingPercent, 77);
  assert.equal(account.source, "settings");
  assert.equal(requests[0].headers.authorization, "Bearer synthetic-token");
  assert.equal(requests[0].headers["chatgpt-account-id"], "test-account");
  assert.equal(snapshot.accounts.length, 1, "legacy hand-entered quota is ignored");
  assert.ok(!JSON.stringify(snapshot).includes("synthetic-token"));
  await sandbox.module.exports.onUnload();
});

test("a source-setting event invalidates an in-flight snapshot before it can publish", async () => {
  const f = fixture({ autoDetect: false, credentials: '{"openai-codex":"synthetic"}' });
  let release, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  f.pi.net = { fetch: async () => {
    entered();
    await new Promise((resolve) => { release = resolve; });
    return { status: 200, bodyText: '{"rate_limit":{"primary_window":{"used_percent":20}}}' };
  } };
  const file = path.resolve(__dirname, "../main.js");
  const actualRequire = createRequire(file);
  const sandbox = { pi: f.pi, module: { exports: {} }, Buffer, console, process: { env: {} },
    require(name) {
      if (name === "./lib/oauth") return { createAuth: () => ({ listAccounts: async () => [], stop: async () => {} }) };
      return actualRequire(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });
  const plugin = sandbox.module.exports;
  await plugin.onLoad();
  await started;
  f.stored.demoMode = true;
  f.events.emit("plugin:settingsChanged");
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await new Promise((resolve) => setImmediate(resolve));
  const result = await plugin.onRendererCall("quota.read", {});
  assert.equal(result.snapshot.demo, true);
  assert.ok(result.snapshot.accounts.every((row) => row.demo === true));
  await plugin.onUnload();
});
