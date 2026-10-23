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
const reply = (data, status = 200) => ({ status, bodyText: JSON.stringify(data) });
function app(settings = {}, pluginCredentials = {}, fetcher, cliData = null) {
  let changed, cliReads = 0;
  const requests = [], cliPaths = [];
  let records = Array.isArray(pluginCredentials) ? pluginCredentials : Object.entries(pluginCredentials).map(([vendor, credential]) =>
    ({ id: `saved-${vendor}`, vendor, label: `${vendor} 1`, credential }));
  const metadata = () => records.map((r) => ({ id: r.id, vendor: r.vendor, label: r.label,
    priority: records.filter((a) => a.vendor === r.vendor).indexOf(r) + 1, connected: true }));
  const auth = {
    listAccounts: async () => metadata(),
    credential: async (id) => records.find((r) => r.id === id)?.credential ?? null,
    status: async () => ({ ok: true, accounts: metadata(), login: null }),
    logout: async (id) => { records = records.filter((r) => r.id !== id); changed(); return auth.status(); },
    move: async (id, direction) => {
      const i = records.findIndex((r) => r.id === id), j = i + (direction === "up" ? -1 : 1);
      [records[i], records[j]] = [records[j], records[i]]; changed(); return auth.status();
    },
    stop: async () => {},
    start: async () => { throw new Error("must not start in demo"); },
  };
  const pi = { plugin: { getSettings: async () => settings, setSettings: async (partial) => Object.assign(settings, partial) },
    commands: { unregister: async () => {} }, net: { fetch: async (input) => { requests.push(input); return fetcher(input); } } };
  const sandbox = { pi, module: { exports: {} }, console, Buffer,
    require(name) {
      if (name === "./lib/oauth") return { createAuth: (_pi, opts) => { changed = opts.onChange; return auth; } };
      if (name === "node:fs/promises") return {
        stat: async (file) => { cliReads++; cliPaths.push(file); if (!cliData) throw new Error("no CLI installed"); return { isFile: () => true, size: 128 }; },
        readFile: async () => JSON.stringify(cliData),
      };
      if (name === "node:os") return { homedir: () => "/nonexistent-home" };
      return actualRequire(name);
    }, process: { env: {} } };
  vm.runInNewContext(code, sandbox, { filename: file });
  return { invoke: sandbox.module.exports.onRendererCall, requests, cliPaths, get cliReads() { return cliReads; } };
}

test("plugin login drives ChatGPT quota with autoDetect off and no CLI", async () => {
  const a = app({ autoDetect: false }, { "openai-codex": { token: "private-plugin-token", accountId: "acct-1", source: "plugin" } }, () => reply({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000 } } }));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.ok, true);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].windows[0].remainingPercent, 75);
  assert.equal(result.accounts[0].plan, "plus");
  assert.equal(a.requests[0].headers["chatgpt-account-id"], "acct-1");
  assert.equal(a.requests[0].headers.authorization, "Bearer private-plugin-token");
  assert.equal(a.cliReads, 0);
  assert.ok(!JSON.stringify(result).includes("private-plugin-token"));
  await a.invoke("quota.auth.logout", { accountId: "saved-openai-codex" });
  assert.equal((await a.invoke("quota.snapshot", {})).accounts.length, 0);
});

test("manual tokens and plugin accounts are displayed independently with autoDetect off", async () => {
  const a = app({ autoDetect: false, credentials: { "openai-codex": { token: "manual", accountId: "manual-acct" }, openrouter: "or-key" } },
    { "openai-codex": { token: "plugin" } }, () => reply({}));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts.length, 2);
  const req = a.requests.find((r) => r.headers.authorization === "Bearer manual");
  assert.equal(req.headers.authorization, "Bearer manual");
  assert.equal(req.headers["chatgpt-account-id"], "manual-acct");
  assert.equal(a.cliReads, 0);
});

test("CLI discovery is optional fallback only", async () => {
  const a = app({ autoDetect: true }, { "openai-codex": { token: "saved" } }, () => reply({}));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].provider, "openai-codex");
  assert.equal(a.cliReads, 0);
});

test("demo is offline and refuses new OAuth starts", async () => {
  const a = app({ demoMode: true, autoDetect: true });
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.demo, true);
  assert.ok(result.accounts.length > 0);
  assert.equal(a.requests.length, 0);
  assert.equal(a.cliReads, 0);
  assert.equal((await a.invoke("quota.auth.start", { vendor: "openai-codex" })).code, "DEMO_MODE");
});

test("a revoked credential surfaces 401 without repeating another usage endpoint or leaking body", async () => {
  const a = app({ autoDetect: false }, { "openai-codex": { token: "secret" } }, () => reply({ error: "secret" }, 401));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].status, "error");
  assert.match(result.accounts[0].error, /401/);
  assert.ok(!JSON.stringify(result).includes("secret"));
  assert.equal(a.requests.length, 1);
});

test("logout invalidates an in-flight snapshot instead of caching the previous account", async () => {
  let resolve;
  const pending = new Promise((r) => { resolve = r; });
  const a = app({ autoDetect: false }, { "openai-codex": { token: "old" } }, () => pending);
  const snapshot = a.invoke("quota.refresh", {});
  await new Promise((r) => setImmediate(r));
  await a.invoke("quota.auth.logout", { accountId: "saved-openai-codex" });
  resolve(reply({ rate_limit: { primary_window: { used_percent: 10 } } }));
  assert.equal((await snapshot).code, "AUTH_CHANGED");
  assert.equal((await a.invoke("quota.snapshot", {})).accounts.length, 0);
});

test("legacy vendors, custom sources and hand-entered quotas are ignored without erasing settings", async () => {
  const settings = { autoDetect: false, credentials: { anthropic: "old", openrouter: "old" },
    sources: [{ vendor: "xai", url: "https://api.x.ai/quota" }],
    accounts: [{ provider: "openai-codex", windows: [{ period: "session", usedPercent: 20 }] }] };
  const before = JSON.stringify(settings);
  const a = app(settings, { anthropic: { token: "legacy" }, "github-copilot": { token: "legacy" } });
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts.length, 0);
  assert.equal(a.requests.length, 0);
  assert.equal(a.cliReads, 0);
  assert.equal(JSON.stringify(settings), before);
});

test("multiple ChatGPT accounts keep headers isolated; exhausted/error accounts are not recommended", async () => {
  const records = ["a", "b", "c"].map((id) => ({ id, vendor: "openai-codex", label: `Account ${id}`,
    credential: { token: `private-${id}`, accountId: `upstream-${id}`, source: "plugin" } }));
  const a = app({ autoDetect: false }, records, (req) => {
    const id = req.headers.authorization.slice(-1);
    assert.equal(req.headers["chatgpt-account-id"], `upstream-${id}`);
    if (id === "c") return reply({}, 401);
    return reply({ rate_limit: { primary_window: { used_percent: id === "a" ? 100 : 20, limit_window_seconds: 18000 } } });
  });
  const result = await a.invoke("quota.refresh", {});
  assert.deepEqual(Array.from(result.accounts, (r) => r.id), ["plugin:a", "plugin:b", "plugin:c"]);
  assert.deepEqual(Array.from(result.accounts, (r) => r.availability), ["exhausted", "available", "unknown"]);
  assert.deepEqual(Array.from(result.accounts, (r) => r.recommended), [false, true, false]);
  assert.ok(!JSON.stringify(result).includes("private-"));
  assert.ok(!JSON.stringify(result).includes("upstream-"));
  await a.invoke("quota.auth.logout", { accountId: "a" });
  assert.deepEqual(Array.from((await a.invoke("quota.snapshot", {})).accounts, (r) => r.id), ["plugin:b", "plugin:c"]);
});

test("priority changes invalidate the snapshot cache and change the recommendation", async () => {
  const a = app({ autoDetect: false }, ["a", "b"].map((id) => ({ id, vendor: "openai-codex", label: id,
    credential: { token: id, source: "plugin" } })), () => reply({ rate_limit: { primary_window: { used_percent: 10 } } }));
  assert.equal((await a.invoke("quota.snapshot", {})).accounts.find((r) => r.recommended).id, "plugin:a");
  await a.invoke("quota.auth.move", { accountId: "b", direction: "up" });
  const snapshot = await a.invoke("quota.snapshot", {});
  assert.equal(snapshot.accounts[0].id, "plugin:b");
  assert.equal(snapshot.accounts[0].priority, 1);
  assert.equal(snapshot.accounts[0].recommended, true);
});

const fakeJwt = (claims) => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;

test("ChatGPT plugin account prefers the profile name and still carries the email", async () => {
  const token = fakeJwt({ "https://api.openai.com/profile": { name: "山口 愛", email: "alice@example.com" } });
  const a = app({ autoDetect: false }, { "openai-codex": { token, accountId: "acct-1", source: "plugin" } },
    () => reply({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } }));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].label, "OpenAI (ChatGPT Plus/Pro) · 山口 愛");
  assert.equal(result.accounts[0].identity, "山口 愛");
  assert.equal(result.accounts[0].email, "alice@example.com");
  assert.equal(result.accounts[0].vendorName, "OpenAI (ChatGPT Plus/Pro)");
  assert.ok(!JSON.stringify(result).includes(token));
});

test("ChatGPT plugin account falls back to the email when the token has no name", async () => {
  const token = fakeJwt({ "https://api.openai.com/profile": { email: "alice@example.com" } });
  const a = app({ autoDetect: false }, { "openai-codex": { token, accountId: "acct-1", source: "plugin" } },
    () => reply({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } }));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].label, "OpenAI (ChatGPT Plus/Pro) · alice@example.com");
  assert.equal(result.accounts[0].identity, "alice@example.com");
});

test("ChatGPT account without a readable email falls back to the vendor name, not the default number", async () => {
  const a = app({ autoDetect: false }, { "openai-codex": { token: "opaque-token", source: "plugin" } },
    () => reply({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } }));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].label, "OpenAI (ChatGPT Plus/Pro)");
  assert.equal(result.accounts[0].identity, null);
});


test("a stored ChatGPT email wins over the access token claims", async () => {
  const a = app({ autoDetect: false }, { "openai-codex": { token: "opaque", email: "id@example.com", source: "plugin" } },
    () => reply({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } }));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].identity, "id@example.com");
});

test("missing and non-numeric ChatGPT usage never produces fabricated 100 percent", async () => {
  for (const used_percent of [undefined, null, "", "  ", false, true, {}, [], 0, "0"]) {
    const a = app({ autoDetect: false, credentials: { "openai-codex": "synthetic" } }, {},
      () => reply({ rate_limit: { primary_window: { used_percent } } }));
    const result = await a.invoke("quota.refresh", {});
    const windows = result.accounts[0].windows;
    if (used_percent === 0 || used_percent === "0") assert.equal(windows[0].remainingPercent, 100);
    else assert.equal(windows.length, 0);
  }
});

test("source settings invalidate cached quota without forcing a manual refresh", async () => {
  const settings = { autoDetect: false, credentials: { "openai-codex": "first-synthetic" } };
  const a = app(settings, {}, () => reply({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 20 } } }));
  assert.equal((await a.invoke("quota.read", {})).snapshot.demo, false);
  settings.demoMode = true;
  assert.equal((await a.invoke("quota.read", {})).snapshot.demo, true);
  assert.equal(a.requests.length, 1, "demo mode never fetches quota");
  settings.demoMode = false;
  settings.credentials = { "openai-codex": "second-synthetic" };
  await a.invoke("quota.read", {});
  assert.equal(a.requests.at(-1).headers.authorization, "Bearer second-synthetic");
  settings.credentials = {};
  settings.accounts = [{ id: "new-manual", windows: [{ usedPercent: 30, period: "week" }] }];
  const changed = await a.invoke("quota.read", {});
  assert.equal(changed.snapshot.accounts.length, 0, "legacy hand-entered quota is not displayed");
});

test("invalid ChatGPT relative reset values stay unknown", async () => {
  for (const reset_after_seconds of [undefined, null, "", " ", true, false, {}, [], 3600]) {
    const a = app({ autoDetect: false, credentials: { "openai-codex": "synthetic" } }, {},
      () => reply({ rate_limit: { primary_window: { used_percent: 20, reset_after_seconds } } }));
    const result = await a.invoke("quota.refresh", {});
    if (reset_after_seconds === 3600) assert.ok(Date.parse(result.accounts[0].windows[0].resetsAt) > Date.now() + 3500_000);
    else assert.equal(result.accounts[0].windows[0].resetsAt, null);
  }
});

test("Codex fallback only reads its auth.json and only fetches ChatGPT quota", async () => {
  const a = app({ autoDetect: true }, { anthropic: { token: "ignored" } },
    () => reply({ rate_limit: { primary_window: { used_percent: 12 } } }),
    { tokens: { access_token: "synthetic-cli", account_id: "synthetic-account" } });
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].provider, "openai-codex");
  assert.equal(result.accounts[0].source, "cli");
  assert.deepEqual(a.cliPaths, [path.join("/nonexistent-home", ".codex", "auth.json")]);
  assert.equal(a.requests.length, 1);
  assert.equal(new URL(a.requests[0].url).hostname, "chatgpt.com");
  assert.equal(a.requests[0].headers["chatgpt-account-id"], "synthetic-account");
  assert.ok(!JSON.stringify(result).includes("synthetic-cli"));
});

test("ChatGPT 404 fallback stays on chatgpt.com and demo never includes other providers", async () => {
  const a = app({ autoDetect: false, credentials: { "openai-codex": "synthetic" } }, {},
    (request) => request.url.includes("/wham/") ? reply({}, 404)
      : reply({ rate_limit: { primary_window: { used_percent: 20 } } }));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].windows[0].remainingPercent, 80);
  assert.deepEqual(a.requests.map((request) => request.url), [
    "https://chatgpt.com/backend-api/wham/usage", "https://chatgpt.com/backend-api/codex/usage"]);
  const demo = await app({ demoMode: true }).invoke("quota.read", {});
  assert.equal(demo.snapshot.accounts.length, 1);
  assert.ok(demo.snapshot.accounts.every((account) => account.provider === "openai-codex"));
});

test("manifest only exposes ChatGPT network hosts and supported settings", () => {
  const manifest = require("../manifest.json");
  assert.deepEqual(manifest.net.domains, ["auth.openai.com", "chatgpt.com"]);
  assert.deepEqual(manifest.contributes.settings.map((setting) => setting.key),
    ["autoDetect", "demoMode", "refreshSeconds", "weeklyShowBelowPercent", "credentials"]);
});
