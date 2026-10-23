"use strict";

// 订阅额度条的界面行为：用最小 React 替身把 renderer 入口跑起来，验证
// 「未登录也留入口 / 有额度显示 5h+周 / 点开浮层 / 账号页发起登录 / Esc 关闭 / 卸载清理」。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const source = fs.readFileSync(path.join(root, manifest.renderer), "utf8");

const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const intervalCallbacks = [];
globalThis.setInterval = (fn, ms, ...rest) => {
  const timer = realSetInterval(fn, ms, ...rest);
  intervalCallbacks.push({ fn, ms, timer, active: true });
  timer.unref?.();
  return timer;
};
globalThis.clearInterval = (timer) => {
  const entry = intervalCallbacks.find((item) => item.timer === timer);
  if (entry) entry.active = false;
  return realClearInterval(timer);
};

let modelLabel = "gpt-6.1-sol";
const observers = new Set();
let popNode = null;
const composer = { querySelector: () => modelLabel ? { textContent: modelLabel } : null };
const rootNode = { closest: (selector) => selector === ".composer-right" ? composer : null };
globalThis.MutationObserver = class {
  constructor(callback) { this.callback = callback; }
  observe() { observers.add(this); }
  disconnect() { observers.delete(this); }
};
function changeModel(label) {
  modelLabel = label;
  for (const observer of observers) observer.callback();
}

// ── 最小 React：函数组件 + useState / useEffect(deps) / useRef ───────────────
const react = {
  values: [],
  deps: [],
  refs: [],
  cleanups: [],
  cursor: 0,
  queue: [],
  createElement(type, props, ...children) {
    const given = props || {};
    if (given["data-sqb-root"] && given.ref) given.ref.current = rootNode;
    if (given["data-sqb-pop"] && given.ref) given.ref.current = popNode;
    const kids = children.length ? children : given.children;
    return { type, props: { ...given, children: kids } };
  },
  useState(initial) {
    const index = this.cursor++;
    if (!(index in this.values)) this.values[index] = initial;
    const set = (next) => {
      this.values[index] = typeof next === "function" ? next(this.values[index]) : next;
    };
    return [this.values[index], set];
  },
  useEffect(run, deps) {
    const index = this.cursor++;
    const prev = this.deps[index];
    const changed = !prev || !deps
      || deps.length !== prev.length
      || deps.some((value, position) => !Object.is(value, prev[position]));
    if (!changed) return;
    this.deps[index] = deps;
    this.queue.push({ index, run });
  },
  useLayoutEffect(run, deps) {
    const length = this.queue.length;
    this.useEffect(run, deps);
    if (this.queue.length > length) this.queue.at(-1).layout = true;
  },
  useRef(initial) {
    const index = this.cursor++;
    if (!(index in this.refs)) this.refs[index] = { current: initial };
    return this.refs[index];
  },
};

function resetReact() {
  react.values = [];
  react.deps = [];
  react.refs = [];
  react.cleanups = [];
  react.cursor = 0;
  react.queue = [];
}

function createDom() {
  const listeners = new Map();
  return {
    addEventListener(type, handler) {
      listeners.set(type, [...(listeners.get(type) || []), handler]);
    },
    removeEventListener(type, handler) {
      listeners.set(type, (listeners.get(type) || []).filter((fn) => fn !== handler));
    },
    emit(type, event) {
      for (const handler of [...(listeners.get(type) || [])]) handler(event);
    },
    count(type) {
      return (listeners.get(type) || []).length;
    },
  };
}

globalThis.window = {
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener() {},
  removeEventListener() {},
};
globalThis.document = createDom();

function textOf(node) {
  if (node === null || node === undefined || node === false) return "";
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  return textOf(node.props && node.props.children);
}

function findAll(node, predicate, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  findAll(node.props && node.props.children, predicate, out);
  return out;
}

function find(node, predicate) {
  return findAll(node, predicate)[0] || null;
}

async function loadRenderer() {
  const patched = source.replace(
    /^import React from "react";$/m,
    "const React = globalThis.__PI_REACT_STUB__;",
  ).replace('"./model-observer.mjs"', JSON.stringify(pathToFileURL(path.join(root, "renderer/model-observer.mjs")).href))
    .replace('"./quota-reading.mjs"', JSON.stringify(pathToFileURL(path.join(root, "renderer/quota-reading.mjs")).href));
  assert.notEqual(patched, source, "renderer entry must import React from the host import map");
  globalThis.__PI_REACT_STUB__ = react;
  const url = `data:text/javascript;base64,${Buffer.from(patched, "utf8").toString("base64")}`;
  return import(url);
}

const rect = { top: 700, right: 1200, bottom: 726, left: 1080 };
const toggleEvent = { currentTarget: { getBoundingClientRect: () => rect } };

function mount(component) {
  resetReact();
  modelLabel = "gpt-6.1-sol";
  let tree = null;
  const draw = () => {
    react.cursor = 0;
    react.queue = [];
    tree = component({ position: "right" });
  };
  const flush = () => {
    const pending = react.queue;
    react.queue = [];
    for (const item of pending) {
      const previous = react.cleanups[item.index];
      if (typeof previous === "function") previous();
      react.effectPhase = item.layout ? "layout" : "passive";
      react.cleanups[item.index] = item.run();
    }
  };
  draw();
  flush();
  return {
    get tree() {
      return tree;
    },
    async settle(rounds = 3) {
      for (let round = 0; round < rounds; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        draw();
        flush();
      }
      return tree;
    },
    unmount() {
      for (const cleanup of react.cleanups) if (typeof cleanup === "function") cleanup();
      react.cleanups = [];
    },
  };
}

const readySummary = (windows, extra = {}) => ({
  ok: true,
  state: "ready",
  locale: "zh-CN",
  stale: false,
  model: { gpt: true, hint: "openai-codex", modelKey: "row/gpt-5.1-codex" },
  updatedAt: "2026-10-20T10:00:00.000Z",
  account: { vendor: "openai-codex", shortVendor: "ChatGPT", plan: "plus", label: "OpenAI (ChatGPT Plus/Pro) · czp" },
  windows,
  others: 0,
  error: null,
  ...extra,
});

const snapshot = () => ({
  ok: true,
  generatedAt: "2026-10-20T10:00:00.000Z",
  demo: false,
  autoDetect: false,
  refreshSeconds: 300,
  accounts: [
    {
      id: "plugin:1",
      provider: "openai-codex",
      source: "plugin",
      label: "OpenAI (ChatGPT Plus/Pro) · czp",
      identity: "czp",
      plan: "plus",
      status: "ok",
      recommended: true,
      windows: [
        { period: "session", labelKey: "window.session", windowMinutes: 300, usedPercent: 24, remainingPercent: 76, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
        { period: "week", labelKey: "window.week", windowMinutes: 10080, usedPercent: 58, remainingPercent: 42, resetsAt: new Date(Date.now() + 86_400_000 * 3).toISOString() },
      ],
    },
  ],
});

const authIdle = { ok: true, accounts: [{ id: "acct-1", vendor: "openai-codex", label: "openai-codex 1", priority: 1, connected: true }], login: null };
const authWaiting = {
  ok: true,
  accounts: authIdle.accounts,
  login: {
    id: "login-1",
    vendor: "openai-codex",
    status: "waiting",
    method: "browser",
    manual: true,
    message: "请在浏览器完成授权",
    url: "https://auth.openai.com/authorize?x=1",
    expiresAt: Date.now() + 600_000,
  },
};

function scripted({ summary = () => readySummary([{ period: "session", remainingPercent: 76, usedPercent: 24 }]), auth = () => authIdle } = {}) {
  const calls = [];
  let revision = 0;
  return {
    calls,
    dispatch: async (action, payload) => {
      calls.push({ action, payload });
      const method = payload && payload.method;
      if (method === "quota.read") return { ok: true, revision: ++revision, summary: summary(), snapshot: snapshot() };
      if (method === "quota.auth.status") return auth();
      if (method === "quota.auth.start") return authWaiting;
      return { ok: true };
    },
  };
}

function setup(pi) {
  const registered = [];
  const disposers = [];
  const mod = globalThis.__PI_BAR_MODULE__;
  mod.onLoad({
    slots: {
      register: (registration) => {
        registered.push(registration);
        return () => disposers.push("slot");
      },
    },
    ui: { injectStyle: () => () => disposers.push("style") },
    dispatch: pi.dispatch,
  });
  return { registration: registered[0], disposers };
}

async function loadAndSetup(pi) {
  globalThis.__PI_BAR_MODULE__ = await loadRenderer();
  return setup(pi);
}

test("a GPT model with no quota yet still keeps a way in; a ready reading shows only 5h", async (t) => {
  const pi = scripted({
    summary: () => ({
      ok: true,
      state: "empty",
      locale: "zh-CN",
      windows: [],
      account: null,
      model: { gpt: true, hint: "openai-codex" },
    }),
  });
  const { registration } = await loadAndSetup(pi);
  assert.equal(registration.slot, "composerControl");
  assert.deepEqual([...registration.positions], ["right"]);

  const bar = mount(registration.component);
  // This fixture is disposed before mounting another hook tree below.
  await bar.settle();
  const emptyChip = find(bar.tree, (node) => node.type === "button");
  assert.equal(emptyChip.props["data-state"], "empty");
  assert.equal(textOf(emptyChip), "ChatGPT 额度");
  assert.match(emptyChip.props["aria-label"], /点击登录/);
  bar.unmount();

  const ready = scripted();
  globalThis.__PI_BAR_MODULE__ = await loadRenderer();
  const second = setup(ready);
  const bar2 = mount(second.registration.component);
  t.after(() => bar2.unmount());
  await bar2.settle();
  const chip = find(bar2.tree, (node) => node.type === "button");
  assert.equal(chip.props["data-state"], "ready");
  assert.equal(textOf(chip), "5h76%");
  assert.equal(chip.props["data-severity"], "ok");
});

test("switching the actual model label hides, closes, and restores the bar without polling", async (t) => {
  const pi = scripted();
  const { registration } = await loadAndSetup(pi);
  const bar = mount(registration.component);
  t.after(() => bar.unmount());
  await bar.settle();
  find(bar.tree, (node) => node.type === "button").props.onClick(toggleEvent);
  await bar.settle();
  assert.ok(find(bar.tree, (node) => node.props && node.props["data-sqb-pop"]));
  const calls = pi.calls.length;
  changeModel("deepseek-flash");
  await bar.settle();
  assert.equal(find(bar.tree, (node) => node.type === "button"), null);
  assert.equal(bar.tree.props.style.display, "none");
  assert.equal(globalThis.document.count("keydown"), 0);
  changeModel("gpt-6-lung");
  await bar.settle();
  assert.equal(textOf(find(bar.tree, (node) => node.type === "button")), "5h76%");
  assert.equal(pi.calls.length, calls, "model switching does not query providers or session APIs");
  assert.equal(find(bar.tree, (node) => node.props && node.props["data-sqb-pop"]), null);
});

test("clicking the chip opens the plugin's own popover with quota cards", async (t) => {
  const pi = scripted();
  const { registration } = await loadAndSetup(pi);
  const bar = mount(registration.component);
  t.after(() => bar.unmount());
  await bar.settle();
  assert.equal(find(bar.tree, (node) => node.props && node.props["data-sqb-pop"]), null);

  const chip = find(bar.tree, (node) => node.type === "button");
  chip.props.onClick(toggleEvent);
  await bar.settle();

  const pop = find(bar.tree, (node) => node.props && node.props["data-sqb-pop"]);
  assert.ok(pop, "the popover renders inside the same slot tree");
  assert.equal(pop.props.role, "dialog");
  const dialogText = textOf(pop);
  assert.match(dialogText, /5 小时额度/);
  assert.match(dialogText, /每周额度/);
  assert.match(dialogText, /76%/);
  assert.match(dialogText, /42%/);
  assert.match(dialogText, /优先推荐/);
  assert.ok(pi.calls.some((call) => call.payload.method === "quota.read"));
});

test("the accounts tab only lists ChatGPT and starts a plugin-owned login", async (t) => {
  const pi = scripted({ auth: () => ({ ...authIdle, accounts: [...authIdle.accounts,
    { id: "legacy", vendor: "anthropic", label: "Hidden legacy vendor", priority: 1 }] }) });
  const { registration } = await loadAndSetup(pi);
  const bar = mount(registration.component);
  t.after(() => bar.unmount());
  await bar.settle();
  find(bar.tree, (node) => node.type === "button").props.onClick(toggleEvent);
  await bar.settle();

  const accountsTab = find(bar.tree, (node) => node.type === "button" && textOf(node) === "账号");
  assert.ok(accountsTab, "the accounts tab exists");
  accountsTab.props.onClick();
  await bar.settle();
  const accountText = textOf(bar.tree);
  assert.match(accountText, /ChatGPT/);
  assert.doesNotMatch(accountText, /Claude|Copilot|Hidden legacy vendor|自定义来源/);

  const addButton = find(bar.tree, (node) => node.type === "button" && textOf(node) === "添加账号");
  assert.ok(addButton, "ChatGPT offers an add button");
  addButton.props.onClick();
  await bar.settle();

  assert.ok(pi.calls.some((call) => call.payload.method === "quota.auth.start" && call.payload.args.vendor === "openai-codex"));
  const dialogText = textOf(find(bar.tree, (node) => node.props && node.props["data-sqb-pop"]));
  assert.match(dialogText, /请在浏览器完成授权/);
  assert.match(dialogText, /打开浏览器/);
  assert.match(dialogText, /取消/);
  const input = find(bar.tree, (node) => node.type === "input");
  assert.ok(input, "the browser flow offers the manual callback field");
  input.props.onChange({ target: { value: "http://localhost:1455/auth/callback?code=abc&state=xyz" } });
  await bar.settle();
  const submit = find(bar.tree, (node) => node.type === "button" && textOf(node) === "提交");
  assert.equal(submit.props.disabled, false);
});

test("Escape closes the popover and it stops listening", async (t) => {
  const pi = scripted();
  const { registration } = await loadAndSetup(pi);
  const bar = mount(registration.component);
  t.after(() => bar.unmount());
  await bar.settle();
  find(bar.tree, (node) => node.type === "button").props.onClick(toggleEvent);
  await bar.settle();
  assert.ok(find(bar.tree, (node) => node.props && node.props["data-sqb-pop"]));
  assert.equal(globalThis.document.count("keydown"), 1);

  globalThis.document.emit("keydown", { key: "Escape" });
  await bar.settle();
  assert.equal(find(bar.tree, (node) => node.props && node.props["data-sqb-pop"]), null);
  assert.equal(globalThis.document.count("keydown"), 0);
});

test("unloading disposes the slot and the style sheet", async () => {
  const pi = scripted();
  const { disposers } = await loadAndSetup(pi);
  globalThis.__PI_BAR_MODULE__.onUnload();
  assert.deepEqual(disposers, ["slot", "style"]);
});

test("manifest exposes only the composer-bar surface", () => {
  assert.equal(manifest.renderer, "renderer/index.mjs");
  assert.deepEqual([...manifest.rendererActions], ["plugin.call"]);
  assert.ok(!manifest.permissions.includes("ui.panel"), "no standalone panel window");
  assert.ok(!manifest.permissions.includes("ui.view"), "no work-panel view");
  assert.equal(manifest.ui, undefined);
  assert.equal(manifest.contributes.views, undefined);
  assert.equal(manifest.contributes.commands, undefined);
  assert.ok(manifest.rendererCallMethods.includes("quota.auth.start"));

  const dispatched = [...source.matchAll(/pi\.dispatch\(\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(dispatched)], ["plugin.call"]);
  const codeOnly = source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
    .join("\n");
  const methods = [...codeOnly.matchAll(/call\("([^"]+)"/g)].map((match) => match[1]);
  for (const method of new Set(methods)) {
    assert.ok(manifest.rendererCallMethods.includes(method), `${method} must be declared in rendererCallMethods`);
  }
});

test("low weekly quota is visible beside 5h with the worst-window risk colour", async (t) => {
  const pi = scripted({ summary: () => readySummary([
    { period: "session", remainingPercent: 76, usedPercent: 24 },
    { period: "week", remainingPercent: 9, usedPercent: 91 },
  ]) });
  const { registration } = await loadAndSetup(pi);
  const bar = mount(registration.component);
  t.after(() => bar.unmount());
  await bar.settle();
  const chip = find(bar.tree, (node) => node.type === "button");
  assert.equal(textOf(chip), "5h76%周9%");
  assert.equal(chip.props["data-severity"], "bad");
  assert.match(chip.props.title, /周 · 剩余 9%/);
});

test("popover styling uses the host's native opaque surface and typography tokens", async () => {
  const module = await loadRenderer();
  let css;
  module.onLoad({
    slots: { register: () => () => {} },
    ui: { injectStyle: (value) => { css = value; return () => {}; } },
    dispatch: async () => null,
  });
  assert.match(css, /background: var\(--ds-bg-elevated-opaque, #282828\)/);
  assert.match(css, /color: var\(--ds-text-primary/);
  assert.match(css, /border: 1px solid var\(--ds-border-default/);
  assert.match(css, /box-shadow: var\(--ds-shadow-dialog/);
  assert.match(css, /var\(--font-mono/);
  assert.doesNotMatch(css, /background: Canvas|color: CanvasText/);
  const card = css.match(/\.sqb-card \{([^}]+)\}/)[1];
  assert.match(card, /background: transparent/);
  assert.match(card, /border: 0/);
  module.onUnload();
});

function syncedReading(revision, remaining) {
  const detail = snapshot();
  detail.revision = revision;
  detail.accounts[0].windows[0].remainingPercent = remaining;
  detail.accounts[0].windows[0].usedPercent = 100 - remaining;
  return { ok: true, revision, summary: readySummary([
    { period: "session", remainingPercent: remaining, usedPercent: 100 - remaining },
  ]), snapshot: detail };
}

function assertSynced(tree, remaining) {
  const chip = find(tree, (node) => node.type === "button" && node.props["data-state"]);
  assert.equal(textOf(chip), `5h${remaining}%`);
  const detailValue = find(tree, (node) => node.props?.className === "sqb-window-value");
  assert.equal(textOf(detailValue), `${remaining}%`);
}

test("opening, refreshing and polling commit the chip and detail together", async (t) => {
  let count = 0;
  const values = [53, 47, 41, 38];
  const forces = [];
  const mark = intervalCallbacks.length;
  const pi = { dispatch: async (_action, payload) => {
    if (payload.method === "quota.read") {
      forces.push(payload.args.force === true);
      return syncedReading(++count, values[count - 1]);
    }
    return authIdle;
  } };
  const { registration } = await loadAndSetup(pi);
  const bar = mount(registration.component);
  t.after(() => bar.unmount());
  await bar.settle();
  assert.equal(textOf(find(bar.tree, (node) => node.type === "button")), "5h53%");
  find(bar.tree, (node) => node.type === "button").props.onClick(toggleEvent);
  await bar.settle();
  assertSynced(bar.tree, 47);
  const refresh = find(bar.tree, (node) => node.type === "button" && textOf(node) === "刷新");
  await refresh.props.onClick();
  await bar.settle();
  assertSynced(bar.tree, 41);
  intervalCallbacks.slice(mark).find((item) => item.ms === 20_000).fn();
  await bar.settle();
  assertSynced(bar.tree, 38);
  assert.deepEqual(forces, [false, false, true, false]);
});

test("a late pre-refresh response cannot roll either surface back", async (t) => {
  let count = 0, resolveOld;
  const pi = { dispatch: async (_action, payload) => {
    if (payload.method !== "quota.read") return authIdle;
    count += 1;
    if (count === 1) return syncedReading(1, 53);
    if (count === 2) return new Promise((resolve) => { resolveOld = resolve; });
    return syncedReading(3, 41);
  } };
  const { registration } = await loadAndSetup(pi);
  const bar = mount(registration.component);
  t.after(() => bar.unmount());
  await bar.settle();
  find(bar.tree, (node) => node.type === "button").props.onClick(toggleEvent);
  await bar.settle();
  assertSynced(bar.tree, 53);
  await find(bar.tree, (node) => node.type === "button" && textOf(node) === "刷新").props.onClick();
  await bar.settle();
  assertSynced(bar.tree, 41);
  resolveOld(syncedReading(2, 47));
  await bar.settle();
  assertSynced(bar.tree, 41);
});

test("successful manual authorization synchronizes both quota surfaces immediately", async (t) => {
  let revision = 0;
  const pi = { dispatch: async (_action, payload) => {
    if (payload.method === "quota.read") return syncedReading(++revision, revision <= 2 ? 53 : 47);
    if (payload.method === "quota.auth.status") return authWaiting;
    if (payload.method === "quota.auth.submit") return { ...authIdle, login: { status: "success" } };
    return authIdle;
  } };
  const { registration } = await loadAndSetup(pi);
  const bar = mount(registration.component);
  t.after(() => bar.unmount());
  await bar.settle();
  find(bar.tree, (node) => node.type === "button").props.onClick(toggleEvent);
  await bar.settle();
  find(bar.tree, (node) => node.type === "button" && textOf(node) === "账号").props.onClick();
  await bar.settle();
  find(bar.tree, (node) => node.type === "input").props.onChange({ target: { value: "http://localhost:1455/auth/callback?code=test&state=test" } });
  await bar.settle();
  await find(bar.tree, (node) => node.type === "button" && textOf(node) === "提交").props.onClick();
  await bar.settle();
  find(bar.tree, (node) => node.type === "button" && textOf(node) === "额度").props.onClick();
  await bar.settle();
  assertSynced(bar.tree, 47);
});

test("popover correction runs before paint and never clears or rewrites an unchanged transform", async (t) => {
  let x = 0, y = 0, height = 250;
  const writes = [];
  popNode = {
    style: { set transform(value) {
      writes.push({ value, phase: react.effectPhase });
      const match = /^translate\(([-\d.]+)px, ([-\d.]+)px\)$/.exec(value);
      assert.ok(match, "must not clear the transform to measure");
      x = Number(match[1]); y = Number(match[2]);
    } },
    getBoundingClientRect: () => ({ left: 900 + x, top: 500 + y, width: 376, height }),
  };
  const pi = scripted();
  const { registration } = await loadAndSetup(pi);
  const bar = mount(registration.component);
  t.after(() => { bar.unmount(); popNode = null; });
  await bar.settle();
  find(bar.tree, (node) => node.type === "button").props.onClick(toggleEvent);
  await bar.settle();
  assert.deepEqual(writes, [{ value: "translate(-76px, -58px)", phase: "layout" }]);
  await find(bar.tree, (node) => node.type === "button" && textOf(node) === "刷新").props.onClick();
  await bar.settle();
  assert.equal(writes.length, 1, "new snapshot with the same geometry must not mutate style");
  height = 100;
  find(bar.tree, (node) => node.type === "button" && textOf(node) === "账号").props.onClick();
  await bar.settle();
  assert.deepEqual(writes.at(-1), { value: "translate(-76px, 92px)", phase: "layout" });
});

test("CLI auth failure stays open without a retry loop and a manual refresh can recover", async (t) => {
  let reads = 0, recovered = false;
  const pi = { dispatch: async (_action, payload) => {
    if (payload.method !== "quota.read") return authIdle;
    reads += 1;
    if (recovered) return syncedReading(2, 76);
    const detail = snapshot();
    detail.accounts = [{ id: "openai-codex", provider: "openai-codex", label: "ChatGPT",
      source: "cli", status: "error", windows: [], error: "HTTP 401" }];
    return { ok: true, revision: 1, summary: readySummary([], { state: "empty", account: null }), snapshot: detail };
  } };
  const { registration } = await loadAndSetup(pi);
  const bar = mount(registration.component);
  t.after(() => bar.unmount());
  await bar.settle();
  find(bar.tree, (node) => node.type === "button").props.onClick(toggleEvent);
  await bar.settle(10);
  assert.match(textOf(find(bar.tree, (node) => node.props?.["data-sqb-pop"])), /HTTP 401/);
  assert.equal(reads, 2, "only mount and opening should read quota");
  recovered = true;
  await find(bar.tree, (node) => node.type === "button" && textOf(node) === "刷新").props.onClick();
  await bar.settle();
  assertSynced(bar.tree, 76);
  assert.equal(reads, 3);
});

test("an initialization RPC failure preserves an open panel and retry recovers", async (t) => {
  let reads = 0;
  const pi = { dispatch: async (_action, payload) => {
    if (payload.method !== "quota.read") throw new Error("not ready");
    reads += 1;
    if (reads === 2) throw new Error("not ready");
    return syncedReading(reads, 76);
  } };
  const { registration } = await loadAndSetup(pi);
  const bar = mount(registration.component);
  t.after(() => bar.unmount());
  await bar.settle();
  find(bar.tree, (node) => node.type === "button").props.onClick(toggleEvent);
  await bar.settle(10);
  assert.match(textOf(find(bar.tree, (node) => node.props?.["data-sqb-pop"])), /unreachable/);
  assert.equal(reads, 2);
  await find(bar.tree, (node) => node.type === "button" && textOf(node) === "重试").props.onClick();
  await bar.settle();
  assertSynced(bar.tree, 76);
});

test("the first failed RPC keeps login and retry reachable, then polling recovers", async (t) => {
  let failed = true, reads = 0;
  const mark = intervalCallbacks.length;
  const pi = { dispatch: async (_action, payload) => {
    if (payload.method !== "quota.read") return authIdle;
    reads += 1;
    if (failed) throw new Error("initialization pending");
    return syncedReading(1, 76);
  } };
  const { registration } = await loadAndSetup(pi);
  const bar = mount(registration.component);
  t.after(() => bar.unmount());
  await bar.settle();
  find(bar.tree, (node) => node.type === "button").props.onClick(toggleEvent);
  await bar.settle(10);
  assert.equal(reads, 2, "failures must not trigger an immediate retry loop");
  assert.match(textOf(find(bar.tree, (node) => node.props?.["data-sqb-pop"])), /unreachable/);
  find(bar.tree, (node) => node.type === "button" && textOf(node) === "账号").props.onClick();
  await bar.settle();
  assert.ok(find(bar.tree, (node) => node.type === "button" && textOf(node) === "添加账号"));
  find(bar.tree, (node) => node.type === "button" && textOf(node) === "额度").props.onClick();
  failed = false;
  intervalCallbacks.slice(mark).find((item) => item.ms === 20_000).fn();
  await bar.settle();
  assertSynced(bar.tree, 76);
  assert.doesNotMatch(textOf(bar.tree), /unreachable/);
});

for (const thrown of [false, true]) {
  test(`late opening ${thrown ? "exception" : "error response"} cannot hide a newer successful refresh`, async (t) => {
    let reads = 0, resolveOld, rejectOld;
    const pi = { dispatch: async (_action, payload) => {
      if (payload.method !== "quota.read") return authIdle;
      reads += 1;
      if (reads === 1) return syncedReading(1, 53);
      if (reads === 2) return new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; });
      return syncedReading(3, 76);
    } };
    const { registration } = await loadAndSetup(pi);
    const bar = mount(registration.component);
    t.after(() => bar.unmount());
    await bar.settle();
    find(bar.tree, (node) => node.type === "button").props.onClick(toggleEvent);
    await bar.settle();
    await find(bar.tree, (node) => node.type === "button" && textOf(node) === "刷新").props.onClick();
    await bar.settle();
    assertSynced(bar.tree, 76);
    if (thrown) rejectOld(new Error("old failure"));
    else resolveOld({ ok: false, message: "old failure" });
    await bar.settle();
    assertSynced(bar.tree, 76);
    assert.doesNotMatch(textOf(bar.tree), /old failure|unreachable/);
  });
}

test("legacy non-ChatGPT quota cards and login flows never render", async (t) => {
  const base = scripted({ auth: () => ({ ...authIdle,
    login: { vendor: "anthropic", status: "waiting", message: "Hidden legacy login" } }) });
  const pi = { dispatch: async (...args) => {
    const result = await base.dispatch(...args);
    if (args[1]?.method === "quota.read") result.snapshot.accounts.push({
      id: "legacy", provider: "anthropic", label: "Hidden legacy card", source: "cli", status: "ok", windows: [] });
    return result;
  } };
  const { registration } = await loadAndSetup(pi);
  const bar = mount(registration.component);
  t.after(() => bar.unmount());
  await bar.settle();
  find(bar.tree, (node) => node.type === "button").props.onClick(toggleEvent);
  await bar.settle();
  assert.doesNotMatch(textOf(bar.tree), /Hidden legacy card/);
  find(bar.tree, (node) => node.type === "button" && textOf(node) === "账号").props.onClick();
  await bar.settle();
  assert.doesNotMatch(textOf(bar.tree), /Hidden legacy login|来自 Codex CLI/);
});

for (const outcome of ["success", "error"]) {
  test(`browser callback polling survives exchanging then ${outcome}`, async (t) => {
    let status = "waiting", reads = 0, revision = 0;
    const pi = { dispatch: async (_action, payload) => {
      if (payload.method === "quota.read") { reads++; return syncedReading(++revision, status === "success" ? 47 : 53); }
      if (payload.method === "quota.auth.status") return { ...authWaiting,
        login: { ...authWaiting.login, status, message: `auth-${status}` } };
      return authIdle;
    } };
    const { registration } = await loadAndSetup(pi);
    const bar = mount(registration.component);
    t.after(() => bar.unmount());
    await bar.settle();
    find(bar.tree, (node) => node.type === "button").props.onClick(toggleEvent);
    await bar.settle();
    find(bar.tree, (node) => node.type === "button" && textOf(node) === "账号").props.onClick();
    await bar.settle();
    const polling = intervalCallbacks.findLast((item) => item.ms === 1500 && item.active);
    assert.ok(polling);
    const before = reads;
    status = "exchanging";
    polling.fn();
    await bar.settle();
    assert.equal(polling.active, true, "token exchange must keep polling alive");
    assert.match(textOf(bar.tree), /auth-exchanging/);
    status = outcome;
    polling.fn();
    await bar.settle();
    assert.equal(polling.active, false, "terminal states must stop polling");
    assert.equal(reads, before + (outcome === "success" ? 1 : 0));
    if (outcome === "error") assert.match(textOf(bar.tree), /auth-error/);
    else {
      find(bar.tree, (node) => node.type === "button" && textOf(node) === "额度").props.onClick();
      await bar.settle();
      assertSynced(bar.tree, 47);
    }
  });
}
