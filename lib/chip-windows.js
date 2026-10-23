"use strict";

function weeklyThreshold(value) {
  if (value == null || value === "" || typeof value === "boolean") return 10;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : 10;
}

/** Keep 5h first; append a low weekly reading only before its reset. */
function selectChipWindows(windows, threshold = 10, now = Date.now()) {
  const order = ["session", "day", "week", "month", "credit", "other"];
  const valid = (Array.isArray(windows) ? windows : [])
    .filter((window) => window && Number.isFinite(window.remainingPercent)
      && window.remainingPercent >= 0 && window.remainingPercent <= 100);
  const rank = (window) => {
    const index = order.indexOf(window.period);
    return index < 0 ? order.length : index;
  };
  const primary = valid.slice().sort((a, b) => rank(a) - rank(b)
    || (a.windowMinutes ?? Infinity) - (b.windowMinutes ?? Infinity))[0];
  if (!primary) return [];
  const weekly = valid.filter((window) => window.period === "week"
    && window !== primary && window.remainingPercent < weeklyThreshold(threshold)
    && (window.resetsAt == null || Date.parse(window.resetsAt) > now))
    .sort((a, b) => a.remainingPercent - b.remainingPercent)[0];
  return weekly ? [primary, weekly] : [primary];
}

module.exports = { weeklyThreshold, selectChipWindows };
