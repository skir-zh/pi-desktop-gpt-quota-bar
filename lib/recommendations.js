"use strict";

// Advisory only: never changes the host's account/model or sends chat requests.
function availability(account, now) {
  if (account.status !== "ok" || !Array.isArray(account.windows) || !account.windows.length) return "unknown";
  let exhausted = false;
  for (const window of account.windows) {
    if (typeof window.remainingPercent !== "number" || !Number.isFinite(window.remainingPercent) ||
        window.remainingPercent < 0 || window.remainingPercent > 100) return "unknown";
    if (window.resetsAt != null) {
      const reset = Date.parse(window.resetsAt);
      if (!Number.isFinite(reset) || reset <= now) return "unknown";
    }
    if (window.remainingPercent === 0) exhausted = true;
  }
  return exhausted ? "exhausted" : "available";
}

function recommendAccounts(accounts, now = Date.now()) {
  const results = accounts.map((account) => account.source === "plugin"
    ? { ...account, availability: availability(account, now), recommended: false }
    : account);
  const best = new Map();
  for (const account of results) {
    if (account.source !== "plugin" || account.availability !== "available") continue;
    const previous = best.get(account.provider);
    if (!previous || account.priority < previous.priority) best.set(account.provider, account);
  }
  for (const account of best.values()) account.recommended = true;
  return results;
}

module.exports = { recommendAccounts };
