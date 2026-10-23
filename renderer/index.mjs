/**
 * GPT 订阅额度条 · 界面
 *
 * 这个插件只有一处界面：输入框工具栏里的额度条（renderer 槽位 `composerControl`）。
 * 点开额度条后，额度卡片、账号管理、插件内登录**全部画在同一枚浮层里**，
 * 没有工作面板视图，也没有独立面板窗口。
 *
 * 边界：
 * - 这里拿不到任何凭据，也不发网络请求；读数与登录都由插件主进程完成
 *   （`plugin.call("quota.*")`，见 main.js 的 onRendererCall）。
 * - 额度条与详情共享一次读数；缓存到期才查询上游，首次失败仍保留登录/重试入口。
 * - 浮层用固定定位贴在额度条上方；若宿主给祖先加了 transform 导致偏移，
 *   挂载后会按按钮实际位置做一次坐标校正。
 * - 组件是普通 React 函数组件，React 由宿主 import map 提供，无构建步骤，因此不用 JSX。
 */
import React from "react";
import { observeComposerModel } from "./model-observer.mjs";
import { acceptReading } from "./quota-reading.mjs";

const h = React.createElement;

/** 每 20s 读取一次；是否查询上游由主进程的配置缓存期限决定。 */
const SUMMARY_POLL_MS = 20_000;
/** 登录等待期间的授权状态轮询。 */
const AUTH_POLL_MS = 1_500;

const VENDOR_LABEL = { "openai-codex": "ChatGPT" };
const LOGIN_VENDORS = ["openai-codex"];

const PERIOD_TAG = {
  "zh-CN": { session: "5h", week: "周", day: "天", month: "月", credit: "余额", other: "额度" },
  en: { session: "5h", week: "wk", day: "day", month: "mo", credit: "credit", other: "quota" },
};

const PERIOD_NAME = {
  "zh-CN": { session: "5 小时额度", week: "每周额度", day: "每日额度", month: "每月额度", credit: "余额", other: "额度" },
  en: { session: "5-hour limit", week: "Weekly limit", day: "Daily limit", month: "Monthly limit", credit: "Credit", other: "Quota" },
};

const TEXT = {
  "zh-CN": {
    chipLabel: "ChatGPT 额度",
    title: "ChatGPT 订阅额度",
    close: "关闭",
    refresh: "刷新",
    refreshing: "刷新中…",
    tabQuota: "额度",
    tabAccounts: "账号",
    remaining: "剩余",
    used: "已用",
    resets: "重置",
    updated: "更新于",
    stale: "数据可能已过期，正在后台刷新",
    loading: "正在读取额度…",
    empty: "还没有额度可显示。到「账号」里登录，或在设置里填手工令牌。",
    failed: "读取失败：",
    retry: "重试",
    demo: "演示数据（设置里关闭「演示数据」即可看真实账号）",
    recommended: "优先推荐",
    sourcePlugin: "插件",
    sourceCli: "CLI",
    sourceSettings: "手工",
    addAccount: "添加账号",
    reauth: "重新授权",
    remove: "删除",
    up: "上移",
    down: "下移",
    noAccounts: "还没有插件账号",
    loginWaiting: "请在浏览器完成授权",
    loginStarting: "正在准备授权…",
    openBrowser: "打开浏览器",
    pasteTitle: "若浏览器没有自动返回，把最终跳转的完整地址粘贴到这里",
    pastePlaceholder: "http://localhost:.../callback?code=...&state=...",
    submit: "提交",
    cancel: "取消",
    done: "完成",
    check: "再次检查",
    settingsHint: "ChatGPT 手工令牌与演示模式在「设置 → 扩展 → GPT 订阅额度条」里配置。",
    cliNote: (count) => `${count} 个 ChatGPT 账号来自 Codex CLI（只读：可在这里看额度，不能在这里管理）`,
    more: (count) => `另有 ${count} 个账号`,
    click: "点击查看额度",
    clickSetup: "点击登录并查看额度",
  },
  en: {
    chipLabel: "ChatGPT quota",
    title: "ChatGPT subscription quota",
    close: "Close",
    refresh: "Refresh",
    refreshing: "Refreshing…",
    tabQuota: "Quota",
    tabAccounts: "Accounts",
    remaining: "remaining",
    used: "used",
    resets: "resets",
    updated: "Updated",
    stale: "Data may be stale; refreshing in the background",
    loading: "Reading quota…",
    empty: "No quota to show yet. Sign in under Accounts, or set a manual token in Settings.",
    failed: "Could not read quota: ",
    retry: "Retry",
    demo: "Demo data (turn off Demo mode in Settings for real accounts)",
    recommended: "Preferred",
    sourcePlugin: "plugin",
    sourceCli: "CLI",
    sourceSettings: "manual",
    addAccount: "Add account",
    reauth: "Re-authorize",
    remove: "Remove",
    up: "Move up",
    down: "Move down",
    noAccounts: "No plugin account yet",
    loginWaiting: "Finish the sign-in in your browser",
    loginStarting: "Preparing sign-in…",
    openBrowser: "Open browser",
    pasteTitle: "If the browser did not return, paste the final redirect URL here",
    pastePlaceholder: "http://localhost:.../callback?code=...&state=...",
    submit: "Submit",
    cancel: "Cancel",
    done: "Done",
    check: "Check again",
    settingsHint: "ChatGPT manual tokens and demo mode live in Settings → Extensions → GPT Subscription Quota Bar.",
    cliNote: (count) => `${count} ChatGPT account${count > 1 ? "s" : ""} read from Codex CLI (read-only here)`,
    more: (count) => `${count} more account${count > 1 ? "s" : ""}`,
    click: "Click to view quota",
    clickSetup: "Click to sign in and view quota",
  },
};

const CSS = `
.sqb-root {
  display: inline-flex;
  align-items: center;
}

.sqb-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  max-width: 260px;
  margin: 0 2px;
  padding: 0 9px;
  border: 1px solid color-mix(in oklab, currentColor 14%, transparent);
  border-radius: 9999px;
  background: color-mix(in oklab, currentColor 5%, transparent);
  color: inherit;
  font: 500 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: pointer;
  transition: background 150ms cubic-bezier(0.22, 1, 0.36, 1),
    border-color 150ms cubic-bezier(0.22, 1, 0.36, 1);
}

.sqb-chip:hover {
  background: color-mix(in oklab, currentColor 10%, transparent);
  border-color: color-mix(in oklab, currentColor 22%, transparent);
}

.sqb-chip:focus-visible,
.sqb-btn:focus-visible,
.sqb-tab:focus-visible,
.sqb-input:focus-visible {
  outline: 2px solid color-mix(in oklab, currentColor 45%, transparent);
  outline-offset: 1px;
}

.sqb-chip[data-state="empty"] {
  gap: 5px;
  opacity: 0.72;
}
.sqb-chip[data-state="empty"] .sqb-dot {
  background: color-mix(in oklab, currentColor 45%, transparent);
}

.sqb-label {
  font-size: 10px;
  letter-spacing: 0.02em;
  opacity: 0.62;
}

.sqb-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--sqb-sev, #40c977);
}

.sqb-win {
  position: relative;
  display: inline-flex;
  align-items: baseline;
  gap: 3px;
  padding-bottom: 4px;
}

.sqb-tag {
  font-size: 10px;
  letter-spacing: 0.02em;
  opacity: 0.62;
}

.sqb-val {
  font-weight: 600;
}

.sqb-bar {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 2px;
  overflow: hidden;
  border-radius: 9999px;
  background: color-mix(in oklab, currentColor 14%, transparent);
}

.sqb-bar::after {
  content: "";
  display: block;
  width: var(--sqb-fill, 0%);
  height: 100%;
  background: var(--sqb-sev, #40c977);
}

.sqb-sep {
  width: 1px;
  height: 10px;
  background: color-mix(in oklab, currentColor 16%, transparent);
}

.sqb-more {
  font-size: 10px;
  opacity: 0.55;
}

.sqb-ok {
  --sqb-sev: #40c977;
}

.sqb-warn {
  --sqb-sev: #ff8549;
}

.sqb-bad {
  --sqb-sev: #ff6764;
}

.sqb-pop {
  position: fixed;
  z-index: 880;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: min(376px, calc(100vw - 32px));
  max-height: min(560px, calc(100dvh - 32px));
  overflow: hidden;
  padding: 16px;
  border: 1px solid var(--ds-border-default, #3a3a3a);
  border-radius: var(--radius-md-plus, 14px);
  background: var(--ds-bg-elevated-opaque, #282828);
  color: var(--ds-text-primary, #fff);
  box-shadow: var(--ds-shadow-dialog, 0 16px 48px rgb(0 0 0 / 55%));
  font: var(--text-xs, 12px)/var(--leading-body, 1.5) -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-variant-numeric: tabular-nums;
}

.sqb-pop-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0;
}

.sqb-pop-title {
  font-size: var(--text-lg, 16px);
  font-weight: var(--font-weight-semibold, 600);
}

.sqb-spacer {
  flex: 1;
}

.sqb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm, 8px);
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.sqb-btn:hover {
  background: color-mix(in oklab, currentColor 8%, transparent);
}

.sqb-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.sqb-btn[data-variant="primary"] {
  border-color: transparent;
  background: color-mix(in oklab, currentColor 14%, transparent);
  font-weight: 600;
}

.sqb-btn[data-variant="danger"]:hover {
  color: #ff6764;
  border-color: color-mix(in oklab, #ff6764 45%, transparent);
}

.sqb-btn[data-size="icon"] {
  width: 24px;
  padding: 0;
  font-size: 13px;
}

.sqb-tabs {
  display: flex;
  gap: 4px;
  padding: 10px 0 0;
}

.sqb-tab {
  height: 24px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11px;
  color: var(--ds-text-muted, #999);
  cursor: pointer;
}

.sqb-tab[data-active="true"] {
  background: color-mix(in oklab, currentColor 6%, transparent);
  color: var(--ds-text-primary, #fff);
  font-weight: 600;
}

.sqb-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 0 0;
  display: grid;
  gap: 18px;
  align-content: start;
}

.sqb-card {
  display: grid;
  gap: 10px;
  padding: 0;
  border: 0;
  background: transparent;
}

.sqb-card-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.sqb-card-name {
  font-weight: 600;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sqb-chip-identity {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ds-text-muted, #999);
  font-size: var(--text-2xs, 11px);
}

.sqb-badge {
  flex: none;
  color: var(--ds-text-muted, #999);
  font-size: var(--text-2xs, 11px);
}

.sqb-window {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: baseline;
  gap: 5px 12px;
}

.sqb-window-label {
  font-size: var(--text-2xs, 11px);
  color: var(--ds-text-muted, #999);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sqb-window-value {
  font: 600 var(--text-xs, 12px)/1.5 var(--font-mono, ui-monospace, monospace);
  text-align: right;
}

.sqb-window-value[data-sev="warn"] {
  color: #ff8549;
}

.sqb-window-value[data-sev="bad"] {
  color: #ff6764;
}

.sqb-track {
  grid-column: 1 / -1;
  height: 3px;
  overflow: hidden;
  border-radius: 9999px;
  background: color-mix(in oklab, currentColor 14%, transparent);
}

.sqb-track-fill {
  height: 100%;
  border-radius: 9999px;
  background: var(--sqb-sev, #40c977);
}

.sqb-meta {
  grid-column: 1 / -1;
  font-size: var(--text-2xs, 11px);
  color: var(--ds-text-muted, #999);
  text-align: right;
}

.sqb-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  border: 0;
}

.sqb-row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
}

.sqb-section {
  display: grid;
  gap: 6px;
}

.sqb-section-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  opacity: 0.8;
}

.sqb-note {
  font-size: var(--text-2xs, 11px);
  color: var(--ds-text-muted, #999);
}

.sqb-banner {
  padding: 7px 9px;
  border-radius: 10px;
  background: color-mix(in oklab, currentColor 7%, transparent);
  font-size: 11px;
  opacity: 0.8;
}

.sqb-banner[data-tone="error"] {
  background: color-mix(in oklab, #ff6764 16%, transparent);
  opacity: 1;
}

.sqb-login {
  display: grid;
  gap: 7px;
  padding: 9px 10px;
  border: 1px solid color-mix(in oklab, currentColor 18%, transparent);
  border-radius: 11px;
  background: color-mix(in oklab, currentColor 6%, transparent);
}

.sqb-input {
  box-sizing: border-box;
  width: 100%;
  height: 26px;
  padding: 0 8px;
  border: 1px solid color-mix(in oklab, currentColor 16%, transparent);
  border-radius: 8px;
  background: color-mix(in oklab, currentColor 3%, transparent);
  color: inherit;
  font: inherit;
  font-size: 11px;
}


.sqb-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-top: 1px solid color-mix(in oklab, currentColor 10%, transparent);
  font-size: 10px;
  opacity: 0.6;
}

@media (prefers-color-scheme: light) {
  .sqb-pop {
    background: var(--ds-bg-elevated-opaque, #fff);
    color: var(--ds-text-primary, #1a1c1f);
    border-color: var(--ds-border-default, #e6e6e6);
  }
  .sqb-ok {
    --sqb-sev: #00a240;
  }

  .sqb-warn {
    --sqb-sev: #e25507;
  }

  .sqb-bad {
    --sqb-sev: #e02e2a;
  }

  .sqb-window-value[data-sev="warn"] {
    color: #e25507;
  }

  .sqb-window-value[data-sev="bad"] {
    color: #e02e2a;
  }
}
`;

// ── 小工具 ──────────────────────────────────────────────────────────────────

let styleDisposer = null;
let slotDisposer = null;

function localeOf(value) {
  return value === "en" ? "en" : "zh-CN";
}

/** 与面板一致的风险分档：<10% 危险、<30% 提醒。 */
function severity(remaining) {
  if (!Number.isFinite(remaining)) return "ok";
  if (remaining < 10) return "bad";
  if (remaining < 30) return "warn";
  return "ok";
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatTime(iso, locale) {
  if (typeof iso !== "string" || !iso) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  try {
    return new Date(at).toLocaleString(locale === "en" ? "en-US" : "zh-CN", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/** 重置时间：能算就写成「2 小时 24 分钟后」，否则退回绝对时间。 */
function formatReset(iso, locale, now = Date.now()) {
  const absolute = formatTime(iso, locale);
  if (!absolute) return "";
  const at = Date.parse(iso);
  const delta = at - now;
  if (!Number.isFinite(delta) || delta <= 0) return absolute;
  const minutes = Math.round(delta / 60_000);
  if (locale === "en") {
    if (minutes < 60) return `in ${minutes}m`;
    if (minutes < 1440) return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    return `in ${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
  }
  if (minutes < 60) return `${minutes} 分钟后`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分后`;
  return `${Math.floor(minutes / 1440)} 天 ${Math.floor((minutes % 1440) / 60)} 小时后`;
}

function windowsOf(account) {
  const windows = account && Array.isArray(account.windows) ? account.windows : [];
  return windows.filter((window) => window && Number.isFinite(window.remainingPercent));
}

function lowestOf(windows) {
  return windows.reduce((min, window) => Math.min(min, window.remainingPercent), Number.POSITIVE_INFINITY);
}

function sourceLabel(source, text) {
  if (source === "plugin") return text.sourcePlugin;
  if (source === "settings") return text.sourceSettings;
  if (source === "cli") return text.sourceCli;
  return "";
}

// ── 额度条 ──────────────────────────────────────────────────────────────────

function winNode(window, locale, key) {
  const remaining = clampPercent(window.remainingPercent);
  const sev = severity(remaining);
  return h("span", { className: "sqb-win", key }, [
    h("span", { key: "tag", className: "sqb-tag" }, PERIOD_TAG[locale][window.period] || PERIOD_TAG[locale].other),
    h("span", { key: "val", className: "sqb-val" }, `${formatPercent(remaining)}%`),
    h("span", {
      key: "bar",
      className: `sqb-bar sqb-${sev}`,
      "aria-hidden": "true",
      style: { "--sqb-fill": `${remaining}%` },
    }),
  ]);
}

function chipTitle(payload, locale, text) {
  const lines = [];
  const account = (payload && payload.account) || {};
  const who = [account.shortVendor || account.vendor, account.plan].filter(Boolean).join(" · ");
  if (who) lines.push(who);
  for (const window of (payload && payload.windows) || []) {
    if (!Number.isFinite(window.remainingPercent)) continue;
    const tag = PERIOD_TAG[locale][window.period] || PERIOD_TAG[locale].other;
    const reset = formatReset(window.resetsAt, locale);
    const parts = [
      tag,
      `${text.remaining} ${formatPercent(window.remainingPercent)}%`,
      `${text.used} ${formatPercent(window.usedPercent)}%`,
    ];
    if (reset) parts.push(`${text.resets} ${reset}`);
    lines.push(parts.join(" · "));
  }
  if (payload && payload.others > 0) lines.push(text.more(payload.others));
  if (payload && payload.stale) lines.push(text.stale);
  lines.push(text.click);
  return lines.join("\n");
}

function chipNode({ payload, locale, text, open, onToggle, buttonRef }) {
  const ready = Boolean(payload) && payload.state === "ready";
  const windows = ready
    ? (payload.windows || []).filter((window) => window && Number.isFinite(window.remainingPercent))
    : [];
  const sev = windows.length ? severity(lowestOf(windows)) : "ok";
  const children = [h("span", {
    key: "dot",
    className: `sqb-dot${windows.length ? ` sqb-${sev}` : ""}`,
    "aria-hidden": "true",
  })];

  if (windows.length) {
    windows.forEach((window, index) => {
      if (index > 0) children.push(h("span", { key: `sep-${index}`, className: "sqb-sep", "aria-hidden": "true" }));
      children.push(winNode(window, locale, `w-${index}`));
    });
  } else {
    children.push(h("span", { key: "label", className: "sqb-label" }, text.chipLabel));
  }

  const summary = windows.length
    ? windows
      .map((window) => `${PERIOD_TAG[locale][window.period] || PERIOD_TAG[locale].other} ${formatPercent(window.remainingPercent)}%`)
      .join(", ")
    : text.clickSetup;

  return h("button", {
    type: "button",
    ref: buttonRef,
    className: "sqb-chip",
    "data-state": windows.length ? "ready" : "empty",
    "data-severity": sev,
    "aria-expanded": open ? "true" : "false",
    "aria-label": `${text.chipLabel}: ${summary}`,
    title: windows.length ? chipTitle(payload, locale, text) : text.clickSetup,
    onClick: onToggle,
  }, children);
}

// ── 浮层：额度卡片 ──────────────────────────────────────────────────────────

function windowRow(window, locale, text, key) {
  const remaining = clampPercent(window.remainingPercent);
  const used = Number.isFinite(window.usedPercent) ? window.usedPercent : 100 - remaining;
  const sev = severity(remaining);
  const name = window.customLabel || PERIOD_NAME[locale][window.period] || PERIOD_NAME[locale].other;
  const reset = formatReset(window.resetsAt, locale);
  const meta = [
    `${text.remaining} ${formatPercent(remaining)}%`,
    `${text.used} ${formatPercent(used)}%`,
    reset ? `${text.resets} ${reset}` : "",
  ].filter(Boolean).join(" · ");
  return h("div", { className: "sqb-window", key }, [
    h("div", { className: "sqb-window-label", key: "label" }, name),
    h("div", { className: "sqb-window-value", key: "value", "data-sev": sev }, `${formatPercent(remaining)}%`),
    h("div", {
      className: "sqb-track",
      key: "track",
      role: "progressbar",
      "aria-valuemin": 0,
      "aria-valuemax": 100,
      "aria-valuenow": remaining,
      "aria-label": name,
    }, h("div", { className: `sqb-track-fill sqb-${sev}`, style: { width: `${remaining}%` } })),
    h("div", { className: "sqb-meta", key: "meta" }, meta),
  ]);
}

function cardNode(account, locale, text) {
  const windows = windowsOf(account);
  const head = [
    h("span", { className: "sqb-card-name", key: "name" }, VENDOR_LABEL[account.provider] || account.provider || "—"),
    account.identity ? h("span", { className: "sqb-chip-identity", key: "identity" }, account.identity) : null,
    account.plan ? h("span", { className: "sqb-badge", key: "plan" }, account.plan) : null,
    account.recommended ? h("span", { className: "sqb-badge", key: "rec" }, text.recommended) : null,
    h("span", { className: "sqb-spacer", key: "spacer" }),
    sourceLabel(account.source, text)
      ? h("span", { className: "sqb-badge", key: "src" }, sourceLabel(account.source, text))
      : null,
  ];
  const body = account.status === "error"
    ? [h("div", { className: "sqb-banner", key: "error", "data-tone": "error" },
      `${text.failed}${account.error || account.hint || text.empty}`)]
    : windows.length
      ? windows.map((window, index) => windowRow(window, locale, text, `${account.id || account.provider}-${index}`))
      : [h("div", { className: "sqb-note", key: "hint" }, account.hint || text.empty)];
  return h("div", {
    className: "sqb-card",
    key: account.id || `${account.provider}-${account.label}`,
    "data-recommended": account.recommended ? "true" : "false",
  }, [h("div", { className: "sqb-card-head", key: "head" }, head)].concat(body));
}

// ── 浮层：账号管理 ──────────────────────────────────────────────────────────

function loginNode(login, text, paste, actions) {
  const vendor = VENDOR_LABEL[login.vendor] || login.vendor;
  const waiting = login.status === "waiting" || login.status === "starting";
  const message = waiting ? text.loginWaiting : login.message || "";
  const children = [
    h("div", { className: "sqb-section-head", key: "head" }, [
      h("span", { key: "vendor" }, vendor),
      h("span", { key: "msg", className: "sqb-note" }, message),
    ]),
  ];


  if (login.method === "browser") {
    children.push(h("div", { className: "sqb-note", key: "paste-hint" }, text.pasteTitle));
    children.push(h("input", {
      className: "sqb-input",
      key: "paste",
      type: "text",
      spellCheck: false,
      value: paste,
      placeholder: text.pastePlaceholder,
      onChange: (event) => actions.paste(event.target.value),
    }));
  }

  const buttons = [h("button", {
    className: "sqb-btn", key: "open", type: "button", disabled: actions.busy, onClick: actions.open,
  }, text.openBrowser)];
  if (login.method === "browser") {
    buttons.push(h("button", {
      className: "sqb-btn",
      key: "submit",
      type: "button",
      "data-variant": "primary",
      disabled: actions.busy || !String(paste || "").trim(),
      onClick: actions.submit,
    }, text.submit));
  }
  buttons.push(h("span", { className: "sqb-spacer", key: "spacer" }));
  buttons.push(h("button", {
    className: "sqb-btn", key: "cancel", type: "button", disabled: actions.busy, onClick: actions.cancel,
  }, text.cancel));
  children.push(h("div", { className: "sqb-card-head", key: "buttons" }, buttons));

  return h("div", { className: "sqb-login", key: "login" }, children);
}

function accountsNode(auth, text, actions) {
  const accounts = auth && Array.isArray(auth.accounts) ? auth.accounts.filter((account) => account?.vendor === "openai-codex") : [];
  return LOGIN_VENDORS.map((vendor) => {
    const rows = accounts.filter((account) => account && account.vendor === vendor);
    const children = [
      h("div", { className: "sqb-section-head", key: "head" }, [
        h("span", { key: "name" }, VENDOR_LABEL[vendor] || vendor),
        h("span", { className: "sqb-spacer", key: "spacer" }),
        h("button", {
          className: "sqb-btn", key: "add", type: "button", disabled: actions.busy,
          onClick: () => actions.start(vendor),
        }, text.addAccount),
      ]),
    ];
    if (!rows.length) {
      children.push(h("div", { className: "sqb-note", key: "empty" }, text.noAccounts));
    } else {
      for (const row of rows) {
        children.push(h("div", { className: "sqb-row", key: row.id }, [
          h("span", { className: "sqb-row-name", key: "name" }, `${row.label || vendor} · P${row.priority}`),
          h("button", {
            className: "sqb-btn", key: "up", type: "button", "data-size": "icon",
            disabled: actions.busy, title: text.up, "aria-label": text.up,
            onClick: () => actions.move(row.id, "up"),
          }, "↑"),
          h("button", {
            className: "sqb-btn", key: "down", type: "button", "data-size": "icon",
            disabled: actions.busy, title: text.down, "aria-label": text.down,
            onClick: () => actions.move(row.id, "down"),
          }, "↓"),
          h("button", {
            className: "sqb-btn", key: "reauth", type: "button",
            disabled: actions.busy, onClick: () => actions.start(vendor, row.id),
          }, text.reauth),
          h("button", {
            className: "sqb-btn", key: "remove", type: "button", "data-variant": "danger",
            disabled: actions.busy, onClick: () => actions.logout(row.id),
          }, text.remove),
        ]));
      }
    }
    return h("div", { className: "sqb-section", key: vendor }, children);
  });
}

// ── 组件 ────────────────────────────────────────────────────────────────────

function createBar(pi) {
  return function QuotaBar() {
    const [reading, setReading] = React.useState(null);
    const summary = reading?.summary ?? null;
    const snapshot = reading?.snapshot ?? null;
    const [open, setOpen] = React.useState(false);
    const [anchor, setAnchor] = React.useState(null);
    const [tab, setTab] = React.useState("quota");
    const [auth, setAuth] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState(null);
    const [notice, setNotice] = React.useState(null);
    const [paste, setPaste] = React.useState("");
    const [frame, setFrame] = React.useState(0);
    const [selectedModel, setSelectedModel] = React.useState({ label: "", gpt: false });
    const rootRef = React.useRef(null);
    React.useEffect(() => observeComposerModel(rootRef.current, setSelectedModel), []);
    const buttonRef = React.useRef(null);
    const popRef = React.useRef(null);
    const popOffset = React.useRef({ node: null, x: 0, y: 0 });

    const requestSequence = React.useRef(0);
    const settledRead = React.useRef(0);
    const acceptedReading = React.useRef(null);
    const mounted = React.useRef(true);
    React.useEffect(() => {
      mounted.current = true;
      return () => { mounted.current = false; };
    }, []);
    const call = async (method, args) => {
      const sequence = ++requestSequence.current;
      try {
        const result = await pi.dispatch("plugin.call", { method, args: args || {} });
        return method === "quota.read" ? { ...result, sequence } : result;
      } catch (caught) {
        if (method !== "quota.read") throw caught;
        return { ok: false, message: "unreachable", sequence };
      }
    };
    const applyReading = (next) => {
      if (!mounted.current || !next || !Number.isFinite(next.sequence)
          || next.sequence < settledRead.current) return;
      settledRead.current = next.sequence;
      if (next.ok === false) {
        setError(next.message || next.code || "unreachable");
        return;
      }
      const accepted = acceptReading(acceptedReading.current, next, next.sequence);
      if (accepted === acceptedReading.current) return;
      acceptedReading.current = accepted;
      setReading(accepted);
      setError(null);
    };

    // 1) 自动轮询：失败保留读数与入口，并显示可重试的错误状态。
    React.useEffect(() => {
      let alive = true;
      const load = () => {
        Promise.resolve()
          .then(() => call("quota.read"))
          .then((next) => {
            if (alive) applyReading(next);
          })
          .catch(() => {});
      };
      load();
      const timer = setInterval(load, SUMMARY_POLL_MS);
      return () => {
        alive = false;
        clearInterval(timer);
      };
    }, []);

    // 2) 打开浮层时取整份快照 + 授权状态。
    React.useEffect(() => {
      if (!open) return undefined;
      let alive = true;
      Promise.resolve()
        .then(() => call("quota.read"))
        .then((next) => {
          if (alive) applyReading(next);
        });
      Promise.resolve()
        .then(() => call("quota.auth.status"))
        .then((next) => {
          if (alive && next && typeof next === "object" && next.ok !== false) setAuth(next);
        })
        .catch(() => {});
      return () => {
        alive = false;
      };
    }, [open]);

    const login = auth?.login?.vendor === "openai-codex" ? auth.login : null;
    const loginWaiting = Boolean(login && ["waiting", "starting", "exchanging"].includes(login.status));

    // 3) 登录等待中轮询授权状态；结束时顺手刷新一次额度。
    React.useEffect(() => {
      if (!open || !loginWaiting) return undefined;
      let alive = true;
      const tick = () => {
        Promise.resolve()
          .then(() => call("quota.auth.status"))
          .then((next) => {
            if (!alive || !next || typeof next !== "object" || next.ok === false) return;
            setAuth(next);
            if (next.login && next.login.status !== "success") return;
            return Promise.resolve()
              .then(() => call("quota.read", { force: true }))
              .then((fresh) => {
                applyReading(fresh);
              });
          })
          .catch(() => {});
      };
      const timer = setInterval(tick, AUTH_POLL_MS);
      return () => {
        alive = false;
        clearInterval(timer);
      };
    }, [open, loginWaiting]);

    // 4) Esc / 点击外部关闭。
    React.useEffect(() => {
      if (!open) return undefined;
      const onKey = (event) => {
        if (event.key === "Escape") setOpen(false);
      };
      const onDown = (event) => {
        const target = event.target;
        if (popRef.current && popRef.current.contains(target)) return;
        if (buttonRef.current && buttonRef.current.contains(target)) return;
        setOpen(false);
      };
      document.addEventListener("keydown", onKey, true);
      document.addEventListener("mousedown", onDown, true);
      return () => {
        document.removeEventListener("keydown", onKey, true);
        document.removeEventListener("mousedown", onDown, true);
      };
    }, [open]);

    // 5) 窗口尺寸变化时重新校正位置。
    React.useEffect(() => {
      if (!open) return undefined;
      const bump = () => setFrame((value) => value + 1);
      window.addEventListener("resize", bump);
      return () => window.removeEventListener("resize", bump);
    }, [open]);

    // 6) 在绘制前校正位置，错误卡片/授权状态改变高度时不能先显示错误位置。
    React.useLayoutEffect(() => {
      if (!open || !anchor) return;
      const node = popRef.current;
      if (!node) return;
      const previous = popOffset.current.node === node
        ? popOffset.current : { node, x: 0, y: 0 };
      const rect = node.getBoundingClientRect();
      const currentAnchor = buttonRef.current?.getBoundingClientRect() ?? anchor;
      const wantLeft = Math.max(8, Math.min(currentAnchor.right - rect.width, window.innerWidth - rect.width - 8));
      const wantTop = Math.max(8, currentAnchor.top - rect.height - 8);
      // rect 已包含上次平移；求累计偏移，不清空 transform 触发额外布局/DOM 观察。
      const x = previous.x + wantLeft - rect.left;
      const y = previous.y + wantTop - rect.top;
      if (Math.abs(x - previous.x) > 0.5 || Math.abs(y - previous.y) > 0.5) {
        node.style.transform = `translate(${x}px, ${y}px)`;
        popOffset.current = { node, x, y };
      }
    }, [open, anchor, tab, snapshot, auth, error, notice, busy, frame]);

    const locale = localeOf(summary && summary.locale);
    const text = TEXT[locale];
    // Observe the model label in this composer, never the tool-only session context API.
    const visible = selectedModel.gpt;

    // 只有模型切到非 GPT 才收起浮层，加载与失败不能移除唯一入口。
    React.useEffect(() => {
      if (!visible && open) setOpen(false);
    }, [visible, open]);

    const toggle = (event) => {
      const rect = event && event.currentTarget ? event.currentTarget.getBoundingClientRect() : null;
      if (rect) setAnchor({ top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left });
      setOpen((value) => {
        if (value) return false;
        setNotice(null);
        setPaste("");
        return true;
      });
    };

    const run = async (method, args) => {
      setBusy(true);
      setNotice(null);
      try {
        const next = await call(method, args);
        if (next && next.ok === false) {
          if (method === "quota.read") { applyReading(next); return null; }
          setNotice({ tone: "error", message: next.message || next.code || "error" });
          return null;
        }
        return next;
      } catch (caught) {
        setNotice({ tone: "error", message: caught && caught.message ? caught.message : String(caught) });
        return null;
      } finally {
        setBusy(false);
      }
    };

    const actions = {
      busy,
      paste: setPaste,
      start: async (vendor, accountId) => {
        const next = await run("quota.auth.start", accountId ? { vendor, accountId } : { vendor });
        if (next && next.accounts) setAuth(next);
        setPaste("");
      },
      open: async () => {
        if (!login) return;
        const next = await run("quota.auth.open", { id: login.id });
        if (next && next.accounts) setAuth(next);
      },
      submit: async () => {
        if (!login) return;
        const next = await run("quota.auth.submit", { id: login.id, input: paste });
        if (next && next.accounts) setAuth(next);
        if (next && (!next.login || next.login.status === "success")) {
          applyReading(await run("quota.read", { force: true }));
        }
        setPaste("");
      },
      cancel: async () => {
        if (!login) return;
        const next = await run("quota.auth.cancel", { id: login.id });
        if (next && next.accounts) setAuth(next);
        setPaste("");
      },
      logout: async (accountId) => {
        const next = await run("quota.auth.logout", { accountId });
        if (next && next.accounts) setAuth(next);
        const fresh = await run("quota.read", { force: true });
        applyReading(fresh);
      },
      move: async (accountId, direction) => {
        const next = await run("quota.auth.move", { accountId, direction });
        if (next && next.accounts) setAuth(next);
        if (next) applyReading(await run("quota.read", { force: true }));
      },
    };

    const refreshAll = async () => {
      setBusy(true);
      try {
        const next = await call("quota.read", { force: true });
        applyReading(next);
      } finally {
        setBusy(false);
      }
    };

    const accounts = (snapshot && Array.isArray(snapshot.accounts) ? snapshot.accounts : [])
      .filter((account) => account?.provider === "openai-codex");

    const body = [];
    if (notice && notice.message) {
      body.push(h("div", {
        className: "sqb-banner",
        key: "notice",
        "data-tone": notice.tone === "error" ? "error" : "info",
      }, notice.message));
    }
    if (tab === "quota") {
      if (error) {
        body.push(h("div", { className: "sqb-banner", key: "error", "data-tone": "error" }, `${text.failed}${error}`));
        body.push(h("div", { className: "sqb-card-head", key: "retry" }, h("button", {
          className: "sqb-btn", type: "button", disabled: busy, onClick: refreshAll,
        }, text.retry)));
      } else if (!snapshot) {
        body.push(h("div", { className: "sqb-note", key: "loading" }, text.loading));
      } else {
        if (snapshot.demo) body.push(h("div", { className: "sqb-banner", key: "demo" }, text.demo));
        if (!accounts.length) body.push(h("div", { className: "sqb-note", key: "empty" }, text.empty));
        for (const account of accounts) body.push(cardNode(account, locale, text));
        if (snapshot.generatedAt) {
          body.push(h("div", { className: "sqb-note", key: "updated" },
            `${text.updated} ${formatTime(snapshot.generatedAt, locale)}`));
        }
      }
    } else {
      if (login) body.push(loginNode(login, text, paste, actions));
      const sections = accountsNode(auth, text, actions);
      for (const section of sections) body.push(section);
      const cliCount = (snapshot && Array.isArray(snapshot.accounts) ? snapshot.accounts : [])
        .filter((account) => account?.provider === "openai-codex" && account.source === "cli").length;
      if (cliCount) body.push(h("div", { className: "sqb-banner", key: "cli", "data-tone": "info" }, text.cliNote(cliCount)));
      body.push(h("div", { className: "sqb-note", key: "settings" }, text.settingsHint));
    }

    const popover = open && anchor
      ? h("div", {
        className: "sqb-pop",
        key: "pop",
        ref: popRef,
        role: "dialog",
        "aria-label": text.title,
        "data-sqb-pop": "1",
        style: {
          right: `${Math.max(8, window.innerWidth - anchor.right)}px`,
          bottom: `${Math.max(8, window.innerHeight - anchor.top + 8)}px`,
        },
      }, [
        h("div", { className: "sqb-pop-head", key: "head" }, [
          h("span", { className: "sqb-pop-title", key: "title" }, text.title),
          h("span", { className: "sqb-spacer", key: "spacer" }),
          h("button", {
            className: "sqb-btn", key: "refresh", type: "button", disabled: busy, onClick: refreshAll,
          }, busy ? text.refreshing : text.refresh),
          h("button", {
            className: "sqb-btn",
            key: "close",
            type: "button",
            "data-size": "icon",
            "aria-label": text.close,
            title: text.close,
            onClick: () => setOpen(false),
          }, "✕"),
        ]),
        h("div", { className: "sqb-tabs", key: "tabs" }, [
          h("button", {
            className: "sqb-tab",
            key: "quota",
            type: "button",
            "data-active": tab === "quota" ? "true" : "false",
            onClick: () => setTab("quota"),
          }, text.tabQuota),
          h("button", {
            className: "sqb-tab",
            key: "accounts",
            type: "button",
            "data-active": tab === "accounts" ? "true" : "false",
            onClick: () => setTab("accounts"),
          }, text.tabAccounts),
        ]),
        h("div", { className: "sqb-body", key: "body" }, body),
      ])
      : null;

    return h("span", {
      className: "sqb-root",
      "data-sqb-root": "1",
      ref: rootRef,
      style: visible ? undefined : { display: "none" },
    }, visible ? [
      chipNode({ payload: summary, locale, text, open, onToggle: toggle, buttonRef }),
      popover,
    ] : null);
  };
}

export function onLoad(pi) {
  try {
    styleDisposer = pi.ui.injectStyle(CSS);
  } catch {
    styleDisposer = null;
  }
  try {
    slotDisposer = pi.slots.register({
      slot: "composerControl",
      positions: ["right"],
      component: createBar(pi),
    });
  } catch (error) {
    // 老宿主没有这个槽位：静默降级（本插件没有别的界面）。
    slotDisposer = null;
    console.warn("[gpt-quota-bar] composer chip unavailable:", error?.message ?? error);
  }
}

export function onUnload() {
  if (slotDisposer) {
    try {
      slotDisposer();
    } catch {
      /* 已经销毁 */
    }
    slotDisposer = null;
  }
  if (styleDisposer) {
    try {
      styleDisposer();
    } catch {
      /* 已经销毁 */
    }
    styleDisposer = null;
  }
}
