"use strict";

/**
 * GPT 订阅额度条 — PI-Desktop 插件主进程
 *
 * 插件 id: io.github.skir-zh.gpt-quota-bar
 * 界面:    renderer/index.mjs → 输入框工具栏的额度条（composerControl 槽位），
 *          额度卡片与账号管理都画在它自己的浮层里。本插件没有工作面板视图，
 *          也没有独立面板窗口，因此不声明 ui.view / ui.panel。
 *
 * 仅查询 ChatGPT 订阅账号的 5 小时 / 每周额度。
 * 凭据来源：插件独立 OAuth 多账号、ChatGPT 手工令牌、可关闭的 Codex CLI 回退。
 * 不读取宿主密钥库，不自动切换宿主账号；额度条选中的账号不一定是宿主当前账号。
 *
 * ── 通道 ────────────────────────────────────────────────────────────────────
 * 全部经 renderer 的 plugin.call → onRendererCall：
 *   quota.summary    只读缓存、过期才后台刷新，绝不阻塞工具栏；
 *   quota.snapshot   完整快照（浮层用）；
 *   quota.refresh    强制刷新；
 *   quota.auth.*     登录状态机（起授权 / 打开浏览器 / 提交回调 / 取消 / 退出 / 调序）。
 * 宿主对自定义通道的转发超时是 30s；刷新令牌 + 两个额度端点各限时 8s。
 */

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createAuth } = require("./lib/oauth");
const { recommendAccounts } = require("./lib/recommendations");
const { weeklyThreshold, selectChipWindows } = require("./lib/chip-windows");
const { createSettingsCompatibility } = require("./lib/settings-json");

/** 上游请求超时；宿主面板通道整体约 30s，留足余量。 */
const REQUEST_TIMEOUT_MS = 8_000;
/** 读凭据文件的体积上限，防御性保护。 */
const MAX_CREDENTIAL_BYTES = 256 * 1024;
const MIN_REFRESH_SECONDS = 30;
const MAX_REFRESH_SECONDS = 3600;

/** 缓存：只存额度快照，不存凭据。 */
let cache = null; // { at: number, snapshot: object }
let cacheEpoch = 0;
let dataSettingsKey = null;
let auth;
function invalidateCache() { cache = null; cacheEpoch += 1; }
function getAuth() {
  if (!auth) auth = createAuth({
    plugin: { getDataPath: () => pi.plugin.getDataPath() },
    net: { fetch: (input) => pi.net.fetch(input) },
    shell: { openExternal: (url) => pi.shell.openExternal(url) },
  }, { onChange: invalidateCache });
  return auth;
}

async function resolveCredential(settings, vendor, cli) {
  const supplied = settingsToken(settings, vendor);
  if (supplied) {
    const entry = settings.credentials?.[vendor];
    const accountId = typeof entry?.accountId === "string" ? entry.accountId : null;
    return { token: supplied, accountId, source: "settings" };
  }
  return settings.autoDetect ? await cli() : null;
}

// ── 设置 ────────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  autoDetect: true,
  demoMode: false,
  refreshSeconds: 300,
  credentials: {},
};

function parseJsonSetting(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function settingsFrom(raw = {}) {
  const seconds = Number(raw.refreshSeconds);
  const refreshSeconds =
    Number.isFinite(seconds) && seconds >= MIN_REFRESH_SECONDS && seconds <= MAX_REFRESH_SECONDS
      ? Math.round(seconds)
      : DEFAULT_SETTINGS.refreshSeconds;
  const credentials = parseJsonSetting(raw.credentials, {});
  return {
    autoDetect: raw.autoDetect !== false,
    weeklyShowBelowPercent: weeklyThreshold(raw.weeklyShowBelowPercent),
    demoMode: raw.demoMode === true,
    refreshSeconds,
    credentials: credentials && typeof credentials === "object" && !Array.isArray(credentials)
      ? { "openai-codex": credentials["openai-codex"] } : {},
  };
}

function trackDataSettings(settings) {
  const key = createHash("sha256").update(JSON.stringify({
    autoDetect: settings.autoDetect, demoMode: settings.demoMode,
    credentials: settings.credentials,
  })).digest("hex");
  if (dataSettingsKey !== null && key !== dataSettingsKey) invalidateCache();
  dataSettingsKey = key;
}

async function getSettings() {
  const settings = settingsFrom((await pi.plugin.getSettings()) ?? {});
  trackDataSettings(settings);
  return settings;
}

/** ChatGPT 手工令牌，支持字符串及 { token, accountId } 两种形状。 */
function settingsToken(settings, vendorId) {
  const entry = settings.credentials?.[vendorId];
  if (typeof entry === "string" && entry.trim()) return entry.trim();
  if (entry && typeof entry === "object") {
    const t = entry.token ?? entry.apiKey ?? entry.accessToken;
    if (typeof t === "string" && t.trim()) return t.trim();
  }
  return null;
}

// ── 通用工具 ────────────────────────────────────────────────────────────────

function num(value) {
  if (value == null || typeof value === "boolean"
      || (typeof value !== "number" && typeof value !== "string")
      || (typeof value === "string" && !value.trim())) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampPercent(value) {
  const n = num(value);
  if (n === null) return null;
  return Math.min(100, Math.max(0, n));
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function isoOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    // 秒级时间戳与毫秒级时间戳都能接受。
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

async function readJsonFile(file) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_CREDENTIAL_BYTES) return null;
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function hasFetch() {
  return typeof pi?.net?.fetch === "function";
}

/** 走宿主的 net.fetch（受 manifest.net.domains 约束）。只有额度数字进缓存。 */
async function httpJson(url, headers) {
  if (!hasFetch()) {
    const error = new Error("宿主未提供 net.fetch");
    error.code = "UNSUPPORTED";
    throw error;
  }
  let response;
  try {
    response = await pi.net.fetch({ url, method: "GET", headers, timeoutMs: REQUEST_TIMEOUT_MS });
  } catch {
    throw Object.assign(new Error("额度网络请求失败，请检查网络及插件权限后重试"), { code: "NETWORK" });
  }
  let data = null;
  try {
    data = JSON.parse(response.bodyText);
  } catch {
    data = null;
  }
  return { status: response.status, data, bodyText: response.bodyText ?? "" };
}

function friendlyHttpError(label, status, bodyText) {
  if (status === 401 || status === 403) return `${label}: 凭据已失效或无权访问（HTTP ${status}），请重新登录该服务`;
  if (status === 404) return `${label}: 额度接口不存在（HTTP 404）`;
  if (status === 429) return `${label}: 请求过于频繁（HTTP 429），稍后重试`;
  if (status >= 500) return `${label}: 服务端错误（HTTP ${status}）`;
  // Never surface upstream bodies: they may echo an Authorization header.
  return `${label}: 请求失败（HTTP ${status}）`;
}

function errorMessage(error) {
  if (!error) return "未知错误";
  const code = error.code ? `[${error.code}] ` : "";
  const text = typeof error.message === "string" ? error.message : String(error);
  return `${code}${text}`;
}

function httpError(label, response) {
  return Object.assign(new Error(friendlyHttpError(label, response.status, response.bodyText)), {
    code: "HTTP_ERROR",
  });
}

// ── 周期与窗口模型 ──────────────────────────────────────────────────────────
//
// period 是机器可读的周期档位（session/day/week/month/credit/other），
// 由界面本地化成「5 小时额度 / 周额度 / 月额度 / 额度余额」。

function periodFromMinutes(minutes) {
  const m = num(minutes);
  if (m === null || m <= 0) return "other";
  if (m <= 360) return "session"; // ≤6 小时：5 小时窗口
  if (m <= 1440) return "day";
  if (m <= 11_000) return "week"; // 7 天
  return "month";
}

const PERIOD_LABEL_KEY = {
  session: "window.session",
  day: "window.day",
  week: "window.week",
  month: "window.month",
  credit: "window.credit",
  other: "window.other",
};

function windowFrom({ period, labelKey, windowMinutes, usedPercent, resetsAt, used, limit, unit }) {
  const usedPct = clampPercent(usedPercent);
  if (usedPct === null) return null;
  const shape = {
    period,
    labelKey: labelKey ?? PERIOD_LABEL_KEY[period] ?? PERIOD_LABEL_KEY.other,
    windowMinutes: num(windowMinutes),
    usedPercent: round1(usedPct),
    remainingPercent: round1(100 - usedPct),
    resetsAt: isoOrNull(resetsAt),
  };
  const usedNum = num(used);
  const limitNum = num(limit);
  if (usedNum !== null && limitNum !== null && limitNum > 0) {
    shape.used = round1(usedNum);
    shape.limit = round1(limitNum);
    shape.unit = typeof unit === "string" && unit ? unit : null;
  }
  return shape;
}

// ── ChatGPT 响应 → 窗口列表 ────────────────────────────────────────────────
/**
 * OpenAI（ChatGPT Plus/Pro）backend-api/wham/usage。
 * 真实形状（已实测）：
 *   rate_limit.primary_window / secondary_window =
 *   { used_percent, limit_window_seconds, reset_after_seconds, reset_at }
 * 18000s = 5 小时，604800s = 7 天；reset_at 是 epoch 秒。
 */
function openAiWindows(data) {
  if (!data || typeof data !== "object") return [];
  const container = data.rate_limit ?? data.rate_limits ?? data.rateLimit ?? data;
  const out = [];
  const push = (raw, fallbackPeriod) => {
    if (!raw || typeof raw !== "object") return;
    const minutes = minutesFrom(raw);
    const period = minutes !== null ? periodFromMinutes(minutes) : fallbackPeriod;
    const resetAtRaw = raw.resets_at ?? raw.resetsAt ?? raw.reset_at ?? raw.resetAt ?? null;
    const afterSeconds = num(
      raw.resets_in_seconds ?? raw.reset_after_seconds ?? raw.reset_in_seconds,
    );
    const resetsAt =
      resetAtRaw === null || resetAtRaw === undefined
        ? afterSeconds !== null
          ? resetRelativeToNow(afterSeconds)
          : null
        : resetAtRaw;
    const built = windowFrom({
      period,
      labelKey: PERIOD_LABEL_KEY[period],
      windowMinutes: minutes,
      usedPercent: raw.used_percent ?? raw.usedPercent ?? raw.utilization,
      resetsAt,
      used: raw.used ?? null,
      limit: raw.limit ?? null,
      unit: raw.unit ?? null,
    });
    if (built) {
      built.key = `${period}-${minutes ?? "x"}`;
      out.push(built);
    }
  };

  push(container.primary_window ?? container.primaryWindow, "session");
  push(container.secondary_window ?? container.secondaryWindow, "week");
  return dedupeWindows(out);
}

function resetRelativeToNow(seconds) {
  const value = num(seconds);
  return value === null ? null : Date.now() + value * 1000;
}

function dedupeWindows(windows) {
  const seen = new Set();
  return windows.filter((w) => (seen.has(w.key) ? false : (seen.add(w.key), true)));
}

/** ChatGPT 额度窗口时长，统一换算为分钟。 */
function minutesFrom(source) {
  const minutes = num(source.window_minutes ?? source.windowMinutes);
  if (minutes !== null) return minutes;
  const seconds = num(source.limit_window_seconds ?? source.window_seconds);
  return seconds !== null ? seconds / 60 : null;
}

// ── 本机凭据发现 ────────────────────────────────────────────────────────────

function homePath(...parts) {
  const home = os.homedir();
  return home ? path.join(home, ...parts) : null;
}

/** Codex CLI：~/.codex/auth.json 的 tokens.access_token / tokens.account_id。 */
async function codexCliCredentials() {
  const file = homePath(".codex", "auth.json");
  if (!file) return null;
  const data = await readJsonFile(file);
  if (!data) return null;
  const tokens = data.tokens ?? {};
  const token =
    (typeof tokens.access_token === "string" && tokens.access_token) ||
    (typeof data.access_token === "string" && data.access_token) ||
    null;
  if (!token) return null;
  const profile = openAiProfile(tokens.id_token);
  return {
    token,
    accountId: typeof tokens.account_id === "string" ? tokens.account_id : null,
    email: profile.email,
    name: profile.name,
    source: file,
  };
}

// ── ChatGPT 账号身份（只解析本地 JWT，不额外请求身份接口）───────────────────

/** 解析 JWT payload；失败或形状不对返回 null。 */
function jwtClaims(token) {
  if (typeof token !== "string") return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const data = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch { return null; }
}

/**
 * ChatGPT 的 profile claim（id_token 与 access token 都带）：`name` 是账号昵称，
 * `email` 是登录邮箱。昵称更接近「这是谁」，所以界面优先显示它。
 */
function openAiProfile(token) {
  const claims = jwtClaims(token);
  const profile = claims?.["https://api.openai.com/profile"];
  const pick = (value) => (typeof value === "string" && value.trim() && [...value.trim()].length <= 80 ? value.trim() : null);
  return {
    name: pick(profile?.name) ?? pick(claims?.name),
    email: pick(profile?.email) ?? pick(claims?.email),
  };
}

/**
 * 插件账号展示：标题用身份（昵称 / 登录名 / 邮箱），邮箱单独带出去。
 * 两者都有时界面把邮箱放在卡片 chip 里，避免长邮箱把标题挤成省略号。
 */
function pluginAccountDisplay(vendor, identity, email) {
  const identityText = typeof identity === "string" ? identity.trim() : "";
  const emailText = typeof email === "string" ? email.trim() : "";
  return {
    identity: identityText || null,
    email: emailText || null,
    vendorName: vendor.name,
    label: identityText ? `${vendor.name} · ${identityText}` : vendor.name,
  };
}

// ── 服务商 ──────────────────────────────────────────────────────────────────
//
// collect(settings) → 账号对象；返回 null 表示「没登录」，界面不显示。

async function collectOpenAiCodex(settings, _vendor, provided) {
  const vendor = "openai-codex";
  const name = "OpenAI (ChatGPT Plus/Pro)";
  const credential = provided ?? await resolveCredential(settings, vendor, codexCliCredentials);
  if (!credential) return null;

  const headers = {
    accept: "application/json",
    authorization: `Bearer ${credential.token}`,
    "user-agent": "pi-desktop-gpt-quota-bar/0.1.0",
  };
  if (credential.accountId) headers["chatgpt-account-id"] = credential.accountId;

  let firstError = null;
  for (const url of [
    "https://chatgpt.com/backend-api/wham/usage",
    "https://chatgpt.com/backend-api/codex/usage",
  ]) {
    try {
      const response = await httpJson(url, headers);
      if (response.status < 200 || response.status >= 300) {
        if (response.status !== 404) throw httpError(name, response);
        if (!firstError) firstError = httpError(name, response);
        continue;
      }
      const windows = openAiWindows(response.data ?? {});
      const plan = response.data?.plan_type ?? response.data?.planType ?? null;
      const who = openAiProfile(credential.token);
      const identity = who.name ?? credential.email ?? who.email;
      return {
        id: vendor,
        provider: vendor,
        source: credential.source === "plugin" ? "plugin" : credential.source === "settings" ? "settings" : "cli",
        label: identity ? `${name} · ${identity}` : name,
        identity,
        email: who.email ?? credential.email ?? null,
        plan: typeof plan === "string" ? plan : null,
        status: windows.length ? "ok" : "empty",
        windows,
        hint: windows.length ? null : "该账号未返回任何额度窗口",
      };
    } catch (error) {
      throw error;
    }
  }
  throw firstError ?? Object.assign(new Error(`${name}: 额度接口不可达`), { code: "NETWORK" });
}

const VENDORS = [{
  id: "openai-codex",
  name: "OpenAI (ChatGPT Plus/Pro)",
  collect: collectOpenAiCodex,
}];

// ── 演示数据 ────────────────────────────────────────────────────────────────

function demoSample() {
  const now = Date.now();
  const at = (ms) => new Date(now + ms).toISOString();
  const hour = 3_600_000;
  const day = 86_400_000;
  return [
    {
      id: "demo-openai",
      provider: "openai-codex",
      label: "OpenAI (ChatGPT Plus/Pro)",
      plan: "plus",
      status: "ok",
      demo: true,
      windows: [
        { key: "session-300", period: "session", labelKey: "window.session", windowMinutes: 300, usedPercent: 12, remainingPercent: 88, resetsAt: at(4.1 * hour) },
        { key: "week-10080", period: "week", labelKey: "window.week", windowMinutes: 10080, usedPercent: 41.7, remainingPercent: 58.3, resetsAt: at(5.2 * day) },
      ],
    },
  ];
}

// ── 快照 ────────────────────────────────────────────────────────────────────

function errorAccount(vendor, error) {
  return {
    id: vendor.id,
    provider: vendor.id,
    label: vendor.name,
    status: "error",
    windows: [],
    error: errorMessage(error),
  };
}

let snapshotRequest = null;
let readingRevision = 0;

/** One collection per authorization epoch, shared by every UI read. */
async function buildSnapshot(options = {}) {
  const settings = await getSettings();
  if (snapshotRequest?.epoch === cacheEpoch) return snapshotRequest.promise;
  const request = { epoch: cacheEpoch, promise: null };
  request.promise = collectSnapshot({ ...options, settings });
  snapshotRequest = request;
  try {
    return await request.promise;
  } finally {
    if (snapshotRequest === request) snapshotRequest = null;
  }
}

async function collectSnapshot({ force = false, settings } = {}) {
  const now = Date.now();
  if (!force && cache && now - cache.at < settings.refreshSeconds * 1000) {
    return { ...cache.snapshot, accounts: recommendAccounts(cache.snapshot.accounts, now), cached: true };
  }

  const snapshotEpoch = cacheEpoch;
  const accounts = [];

  if (settings.demoMode) {
    for (const account of demoSample()) accounts.push(account);
  } else {
    let saved = [], authError = null;
    try { saved = await getAuth().listAccounts(); } catch (error) { authError = error; }
    const collected = await Promise.all(VENDORS.map(async (vendor) => {
      const pluginAccounts = saved.filter((account) => account.vendor === vendor.id)
        .sort((a, b) => a.priority - b.priority);
      const rows = await Promise.all(pluginAccounts.map(async (account) => {
        let row;
        try {
          const credential = await getAuth().credential(account.id);
          if (!credential) throw Object.assign(new Error("账号已删除，请刷新"), { code: "AUTH_CHANGED" });
          row = await vendor.collect(settings, vendor, credential);
        } catch (error) { row = errorAccount(vendor, error); }
        const display = pluginAccountDisplay(vendor, row?.identity, row?.email);
        return { ...row, id: `plugin:${account.id}`, source: "plugin", priority: account.priority,
          identity: display.identity, email: display.email, vendorName: display.vendorName, label: display.label };
      }));
      if (authError) rows.push({ ...errorAccount(vendor, authError), id: `auth:${vendor.id}` });
      // Explicit manual credentials remain visible; CLI is only a fallback.
      if (!pluginAccounts.length || settingsToken(settings, vendor.id)) {
        try {
          const external = await vendor.collect(settings, vendor);
          if (external) rows.push(external);
        } catch (error) { rows.push(errorAccount(vendor, error)); }
      }
      return rows;
    }));
    accounts.push(...collected.flat());
  }

  const snapshot = {
    ok: true,
    generatedAt: new Date().toISOString(),
    demo: settings.demoMode,
    autoDetect: settings.autoDetect,
    refreshSeconds: settings.refreshSeconds,
    accounts: recommendAccounts(accounts),
  };
  if (snapshotEpoch !== cacheEpoch) {
    // Refresh/login/logout occurred while fetching: never cache another epoch.
    throw Object.assign(new Error("账号授权已更新，请刷新额度"), { code: "AUTH_CHANGED" });
  }
  snapshot.revision = ++readingRevision;
  cache = { at: Date.now(), snapshot };
  return snapshot;
}

// ── 对话栏额度条（renderer.extension → composerControl）─────────────────────
//
// 工具栏不是报错界面也不是查询界面：这里只读 buildSnapshot 的缓存，缓存过期时
// 用后台刷新（refreshQuiet）补数据，绝不把 8s 级别的上游请求挂在点击路径上。

/** 卡片与提示里用的厂商简称。 */
const VENDOR_SHORT = { "openai-codex": "ChatGPT" };


/** 上一次后台刷新的失败原因；有缓存时仍显示旧数据，只标记过期。 */
let quotaError = null;

/** 后台刷新：失败只记录，不抛给调用方。 */
async function refreshQuiet(force) {
  try {
    await buildSnapshot({ force });
    quotaError = null;
  } catch (error) {
    quotaError = { code: error?.code ?? "ERROR", message: errorMessage(error) };
  }
}

function lowerText(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** 额度条的语言只有中英两套，宿主其它语言按英文处理。 */
async function chipLocale() {
  try {
    const appearance = await pi.app.getAppearance();
    const locale = lowerText(appearance?.locale);
    if (!locale) return "zh-CN";
    return locale.startsWith("zh") ? "zh-CN" : "en";
  } catch {
    return "zh-CN";
  }
}

function emptyPayload(state, locale, extra = {}) {
  return {
    ok: true,
    state,
    locale,
    stale: false,
    updatedAt: null,
    account: null,
    windows: [],
    others: 0,
    error: null,
    ...extra,
  };
}

/** Return only display-safe fields selected for the compact bar. */
function chipWindows(windows, threshold) {
  return selectChipWindows(windows, threshold).map((window) => ({
      period: window.period,
      labelKey: window.labelKey ?? PERIOD_LABEL_KEY[window.period] ?? PERIOD_LABEL_KEY.other,
      remainingPercent: window.remainingPercent,
      usedPercent: typeof window.usedPercent === "number"
        ? window.usedPercent
        : round1(100 - window.remainingPercent),
      windowMinutes: num(window.windowMinutes),
      resetsAt: window.resetsAt ?? null,
    }));
}

/** 有额度数据的账号才参与候选；同厂商里优先取推荐账号。 */
function pickFocusAccount(accounts, hint) {
  const usable = (Array.isArray(accounts) ? accounts : []).filter((account) => account &&
    account.status === "ok" && Array.isArray(account.windows) && account.windows.length);
  if (!usable.length) return null;
  const hinted = hint ? usable.filter((account) => account.provider === hint) : [];
  const pool = hinted.length ? hinted : usable;
  return pool.find((account) => account.recommended === true) ?? pool[0];
}

/** 纯函数：快照 → 额度条载荷。界面只拿非敏感字段。 */
function chipPayload({ accounts, threshold = 10, locale = "zh-CN", stale = false,
  updatedAt = null, error = null } = {}) {
  const focus = pickFocusAccount((accounts || []).filter((account) => account.provider === "openai-codex"), "openai-codex");
  if (!focus) return emptyPayload(error ? "error" : "empty", locale, { stale, updatedAt, error });
  const windows = chipWindows(focus.windows, threshold);
  if (!windows.length) return emptyPayload("empty", locale, { stale, updatedAt });
  const others = (Array.isArray(accounts) ? accounts : []).filter((account) => account &&
    account !== focus && account.status === "ok" &&
    Array.isArray(account.windows) && account.windows.length).length;
  return {
    ok: true,
    state: "ready",
    locale,
    stale,
    updatedAt,
    account: {
      id: typeof focus.id === "string" ? focus.id : null,
      vendor: typeof focus.provider === "string" ? focus.provider : null,
      shortVendor: VENDOR_SHORT[focus.provider] ?? null,
      label: typeof focus.label === "string" ? focus.label : null,
      plan: typeof focus.plan === "string" ? focus.plan : null,
      source: typeof focus.source === "string" ? focus.source : null,
    },
    windows,
    others,
    error: null,
  };
}

/** Read cached quota only; model visibility belongs to the renderer's own composer. */
async function summaryPayload() {
  const locale = await chipLocale();
  const settings = await getSettings();
  const cached = cache;
  if (!cached) {
    void refreshQuiet(false);
    if (quotaError) return emptyPayload("error", locale, { error: quotaError });
    return emptyPayload("loading", locale);
  }

  const stale = Date.now() - cached.at >= settings.refreshSeconds * 1000;
  if (stale) void refreshQuiet(true);
  return chipPayload({
    accounts: cached.snapshot?.accounts,
    threshold: settings.weeklyShowBelowPercent,
    locale,
    stale,
    updatedAt: cached.snapshot?.generatedAt ?? null,
  });
}

/** Both surfaces are derived from this exact snapshot in one response. */
async function readQuota({ force = false } = {}) {
  const [locale, settings] = await Promise.all([chipLocale(), getSettings()]);
  const expired = !cache || Date.now() - cache.at >= settings.refreshSeconds * 1000;
  const snapshot = await buildSnapshot({ force: force || expired });
  return {
    ok: true,
    revision: snapshot.revision,
    summary: chipPayload({ accounts: snapshot.accounts, threshold: settings.weeklyShowBelowPercent,
      locale, updatedAt: snapshot.generatedAt }),
    snapshot,
  };
}

/**
 * renderer 入口的唯一通道：方法名与 manifest.rendererCallMethods 一一对应。
 *
 * 浮层不是独立窗口，它跑在宿主渲染进程里，所以这里既要有快照也要有登录控制。
 * 除 quota.summary 外都走 CHANNELS；业务失败按 `{ ok: false, code, message }` 回给界面，
 * 只有协议层面的未知方法才抛错。
 */
async function onRendererCall(method, args) {
  if (method === "quota.summary") return summaryPayload();
  const handler = CHANNELS[method];
  if (!handler) {
    throw Object.assign(new Error(`unknown method: ${String(method)}`), { code: "UNSUPPORTED" });
  }
  try {
    return await handler(args ?? {});
  } catch (error) {
    return { ok: false, code: error?.code ?? "ERROR", message: errorMessage(error) };
  }
}

// ── 通道路由 ────────────────────────────────────────────────────────────────

const CHANNELS = {
  "quota.read": (payload) => readQuota({ force: payload?.force === true }),
  "quota.auth.status": () => getAuth().status(),
  "quota.auth.start": async (payload) => {
    if ((await getSettings()).demoMode) return { ok: false, code: "DEMO_MODE", message: "请先关闭演示模式再登录" };
    return getAuth().start(payload.vendor, { accountId: payload.accountId, label: payload.label });
  },
  "quota.auth.open": (payload) => getAuth().open(payload.id),
  "quota.auth.submit": (payload) => getAuth().submit(payload.id, payload.input),
  "quota.auth.cancel": (payload) => getAuth().cancel(payload.id),
  "quota.auth.logout": (payload) => getAuth().logout(payload.accountId),
  "quota.auth.move": (payload) => getAuth().move(payload.accountId, payload.direction),
  "quota.snapshot": (payload) => buildSnapshot({ force: payload?.force === true }),
  "quota.refresh": () => buildSnapshot({ force: true }),
  "quota.setDemo": async (payload) => {
    const enabled = payload?.enabled === true;
    if (enabled && auth) {
      const current = await auth.status();
      if (current.login) await auth.cancel(current.login.id);
    }
    try {
      await pi.plugin.setSettings({ demoMode: enabled });
    } catch {
      /* 设置写入失败不阻塞渲染 */
    }
    invalidateCache();
    return buildSnapshot({ force: true });
  },
};

// ── 生命周期 ────────────────────────────────────────────────────────────────

let settingsCompatibility;

async function onLoad() {
  settingsCompatibility = createSettingsCompatibility(pi, (raw) => trackDataSettings(settingsFrom(raw)));
  await settingsCompatibility.start();
  // 预热缓存：不阻塞加载，失败记录到 quotaError 供额度条提示。
  void refreshQuiet(true);
}

async function onUnload() {
  if (settingsCompatibility) await settingsCompatibility.stop();
  settingsCompatibility = null;
  invalidateCache();
  try {
    if (auth) await auth.stop();
  } finally {
    auth = null;
  }
}

module.exports = { onLoad, onUnload, onRendererCall };
