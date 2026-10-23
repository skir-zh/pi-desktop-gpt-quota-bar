"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { createRequire } = require("node:module");

// PI_BROWSER_DEPS is an optional external npm prefix for CI/session scratch installs.
const deps = process.env.PI_BROWSER_DEPS
  ? createRequire(path.join(path.resolve(process.env.PI_BROWSER_DEPS), "package.json")) : require;
const { chromium } = deps("playwright");
const root = path.resolve(__dirname, "../..");
const reactDir = path.dirname(deps.resolve("react/package.json"));
const reactDomDir = path.dirname(deps.resolve("react-dom/package.json"));
const files = new Map([
  ["/", [path.join(__dirname, "fixture.html"), "text/html"]],
  ["/vendor/react.js", [path.join(reactDir, "umd/react.development.js"), "text/javascript"]],
  ["/vendor/react-dom.js", [path.join(reactDomDir, "umd/react-dom.development.js"), "text/javascript"]],
  ...["index.mjs", "model-observer.mjs", "quota-reading.mjs"].map(name =>
    [`/renderer/${name}`, [path.join(root, "renderer", name), "text/javascript"]]),
]);
let server, browser, base;
before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/react-shim.mjs") {
      res.writeHead(200, { "content-type": "text/javascript" }).end("export default globalThis.React;");
      return;
    }
    const entry = files.get(url.pathname);
    if (!entry) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": entry[1], "cache-control": "no-store" }).end(fs.readFileSync(entry[0]));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    browser = await chromium.launch({ headless: true,
      ...(process.env.PI_BROWSER_CHANNEL ? { channel: process.env.PI_BROWSER_CHANNEL } : {}) });
    console.log(`Real browser: ${browser.version()}`);
  } catch (error) {
    server.close();
    throw error;
  }
});
after(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); });

async function pageFor(t, initial = "ready") {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  t.after(async () => { await page.close(); assert.deepEqual(errors, [], "renderer must not throw"); });
  await page.goto(`${base}/?initial=${initial}`);
  await page.waitForFunction(() => window.harness?.ready);
  await page.locator(".sqb-chip").waitFor({ state: "visible" });
  return page;
}
async function frames(page, count = 20) {
  await page.evaluate(count => new Promise(resolve => {
    const next = () => { if (--count <= 0) resolve(); else requestAnimationFrame(next); };
    requestAnimationFrame(next);
  }), count);
}
function assertFrames(samples) {
  assert.ok(samples.length >= 10, "must sample real animation frames");
  for (const frame of samples) {
    assert.ok(!frame.missing && !frame.replaced, "open popover must keep its DOM node");
    assert.ok(Math.abs(frame.dx) <= 1 && Math.abs(frame.dy) <= 1,
      `popover must be anchored before paint: ${JSON.stringify(frame)}`);
  }
}

test("real React: first failure keeps login/retry reachable and recovers without remount", async t => {
  const page = await pageFor(t, "init-error");
  await page.locator(".sqb-chip").click();
  await page.getByRole("dialog").getByText("读取失败：initialization pending").waitFor();
  await page.getByRole("button", { name: "账号", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "添加账号", exact: true }).count(), 1);
  assert.doesNotMatch(await page.getByRole("dialog").textContent(), /Claude|Copilot|OpenRouter|自定义来源/);
  await page.getByRole("button", { name: "额度", exact: true }).click();
  await page.evaluate(() => { harness.startFrames(); harness.setKind("ready"); });
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await page.locator(".sqb-window-value").first().getByText("76%", { exact: true }).waitFor();
  await frames(page);
  assertFrames(await page.evaluate(() => harness.stopFrames()));
  assert.equal(await page.evaluate(() => harness.reads), 3);
});

test("real layout: CLI 401 and changing card heights stay stable under transformed ancestors", async t => {
  const page = await pageFor(t);
  await page.locator(".sqb-chip").click();
  await page.locator(".sqb-window-value").first().waitFor();
  await page.evaluate(() => harness.startFrames());
  for (const kind of ["cli-error", "ready", "cli-error", "ready"]) {
    await page.evaluate(kind => harness.setKind(kind), kind);
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    if (kind === "cli-error") await page.getByText(/HTTP 401/).waitFor();
    else await page.locator(".sqb-window-value").first().waitFor();
    await frames(page, 12);
  }
  await page.getByRole("button", { name: "账号", exact: true }).click();
  await frames(page, 12);
  await page.getByRole("button", { name: "额度", exact: true }).click();
  await frames(page, 12);
  const samples = await page.evaluate(() => harness.stopFrames());
  assertFrames(samples);
  assert.ok(new Set(samples.map(frame => Math.round(frame.height))).size > 1, "must exercise different heights");
  assert.equal(await page.evaluate(() => harness.reads), 6, "no DOM-driven request storm");
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
});

test("real React: an old failed read cannot overwrite a newer refreshed detail", async t => {
  const page = await pageFor(t);
  await page.evaluate(() => harness.plan("defer:opening"));
  await page.locator(".sqb-chip").click();
  await page.waitForFunction(() => harness.pending.includes("opening"));
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.locator(".sqb-window-value").first().waitFor();
  await page.evaluate(() => { harness.startFrames(); harness.resolve("opening", "old-error"); });
  await frames(page);
  assertFrames(await page.evaluate(() => harness.stopFrames()));
  assert.equal(await page.getByText(/old failure/).count(), 0);
  assert.equal(await page.locator(".sqb-window-value").first().textContent(), "76%");
});

test("real layout: resize reanchors the open popover to the moved composer", async t => {
  const page = await pageFor(t);
  await page.locator(".sqb-chip").click();
  await page.locator(".sqb-window-value").first().waitFor();
  for (const viewport of [{ width: 980, height: 680 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await frames(page, 3);
    await page.evaluate(() => harness.startFrames());
    await frames(page, 12);
    assertFrames(await page.evaluate(() => harness.stopFrames()));
  }
});
