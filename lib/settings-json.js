"use strict";

const JSON_SETTINGS = ["credentials"];

/**
 * The host JSON editor renders objects with JSON.stringify, but its save path
 * parses String(value). Keep JSON fields as valid text at the host boundary.
 * Runtime readers continue accepting both text and structured legacy values.
 */
function jsonTextPatch(settings) {
  const patch = {};
  for (const key of JSON_SETTINGS) {
    const value = settings?.[key];
    if (value == null || typeof value !== "object") continue;
    try {
      patch[key] = JSON.stringify(value, null, 2);
    } catch {
      // Do not include settings or credential values in diagnostics.
      throw new Error("Cannot serialize plugin JSON settings");
    }
  }
  return patch;
}

function createSettingsCompatibility(pi, onSettings = () => {}) {
  let active = false;
  let queue = Promise.resolve();
  const normalize = () => {
    const run = async () => {
      if (!active) return;
      const current = await pi.plugin.getSettings();
      if (!active) return;
      onSettings(current);
      const patch = jsonTextPatch(current);
      if (Object.keys(patch).length) await pi.plugin.setSettings(patch);
    };
    const next = queue.then(run, run);
    queue = next;
    return next;
  };
  const changed = () => {
    void normalize().catch(() => console.warn("[gpt-quota-bar] Could not normalize JSON settings"));
  };
  return {
    async start() {
      active = true;
      pi.events.on("plugin:settingsChanged", changed);
      try {
        await normalize();
      } catch (error) {
        active = false;
        pi.events.off("plugin:settingsChanged", changed);
        throw error;
      }
    },
    async stop() {
      active = false;
      pi.events.off("plugin:settingsChanged", changed);
      // Failures are reported by start/the event handler; still finish cleanup.
      await queue.catch(() => {});
    },
    // Useful for deterministic validation and explicit callers.
    normalize,
  };
}

module.exports = { JSON_SETTINGS, jsonTextPatch, createSettingsCompatibility };
