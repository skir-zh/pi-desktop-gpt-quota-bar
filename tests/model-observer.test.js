"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");

async function fixture(label = "gpt-6.1-sol") {
  const { observeComposerModel } = await import("../renderer/model-observer.mjs");
  const updates = [];
  let callback, disconnected = false, watched;
  let element = { textContent: label };
  const scope = { querySelector(selector) {
    assert.equal(selector, ".composer-model-thinking-model");
    return element;
  } };
  const root = { closest(selector) { assert.equal(selector, ".composer-right"); return scope; } };
  class Observer {
    constructor(fn) { callback = fn; }
    observe(target, options) { watched = target; assert.equal(options.characterData, true); }
    disconnect() { disconnected = true; }
  }
  const stop = observeComposerModel(root, (state) => updates.push(state), Observer);
  return {
    updates, stop, scope,
    get watched() { return watched; },
    get disconnected() { return disconnected; },
    replace(name) { element = name === null ? null : { textContent: name }; callback(); },
    mutate(name) { element.textContent = name; callback(); },
  };
}

for (const label of ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-lung", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "GPT-4o", "codex", "ChatGPT"]) {
  test(`${label} is detected from the rendered model button`, async () => {
    const f = await fixture(label);
    assert.equal(f.updates[0].gpt, true);
    assert.equal(f.watched, f.scope);
    f.stop();
  });
}

test("text mutations, replaced model elements, no-model states and disposal", async () => {
  const f = await fixture();
  f.mutate("deepseek-flash");
  assert.equal(f.updates.at(-1).gpt, false);
  f.replace("gpt-6.1-sol");
  assert.equal(f.updates.at(-1).gpt, true);
  const count = f.updates.length;
  f.replace("gpt-6.1-sol");
  assert.equal(f.updates.length, count, "own UI mutations must not cause a render loop");
  f.replace(null);
  assert.equal(f.updates.at(-1).gpt, false);
  f.stop();
  assert.equal(f.disconnected, true);
});

test("no composer does not inspect another composer's model", async () => {
  const { observeComposerModel } = await import("../renderer/model-observer.mjs");
  const updates = [];
  observeComposerModel({ closest: () => null }, (value) => updates.push(value));
  assert.deepEqual(updates, [{ label: "", gpt: false }]);
});
