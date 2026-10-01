#!/usr/bin/env node
// Synthetic shell/Worker probe. Does not replace authenticated API or Unity acceptance tests.
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  renderPlayShell,
  playShellHeaders,
} from "../apps/api/dist/modules/webgl-play/runtime-ui.js";
import { runtimeCsp } from "../apps/api/dist/modules/webgl-play/service.js";
const require = createRequire(import.meta.url);
const playwright = process.env.PLAYWRIGHT_MODULE_PATH
  ? await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href)
  : require("playwright");
const engine =
  process.env.PLAYWRIGHT_BROWSER ||
  (["chromium", "firefox", "webkit"].includes(process.env.BROWSER)
    ? process.env.BROWSER
    : "chromium");
const token = "a".repeat(64),
  otherToken = "b".repeat(64),
  controlSecret = "c".repeat(64);
const title =
  '<img src=x onerror="window.titleInjected=true"> & malicious title';
let renewals = 0,
  closes = 0,
  denyRenew = false,
  otherRequests = 0;
const assetRequests = [];
let apiOrigin, assetOrigin, config;
const serve = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
const origin = (server) => `http://127.0.0.1:${server.address().port}`;
const json = (res, status, data) => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(
    JSON.stringify(
      status === 200
        ? { ok: true, data }
        : { ok: false, error: { code: "FORBIDDEN" } },
    ),
  );
};
const api = await serve((req, res) => {
  if (req.url === "/play/projects/1") {
    res.writeHead(200, {
      ...playShellHeaders(config),
      "Content-Type": "text/html",
    });
    return res.end(renderPlayShell(config, 1));
  }
  if (req.method === "POST" && req.url.startsWith("/api/webgl-play/sessions")) {
    if (req.url.endsWith("/renew")) {
      renewals++;
      assert.equal(req.headers["x-pcu-play-control"], controlSecret);
      return json(res, denyRenew ? 403 : 200, {
        expiresAt: new Date(Date.now() + 900000).toISOString(),
        absoluteExpiresAt: new Date(Date.now() + 28800000).toISOString(),
      });
    }
    if (req.url.endsWith("/close")) {
      closes++;
      return json(res, 200, { closed: true });
    }
    return json(res, 200, {
      id: "11111111-1111-4111-8111-111111111111",
      controlSecret,
      iframeUrl: `${assetOrigin}/runtime/${token}/index.html`,
      projectTitle: title,
      expiresAt: new Date(Date.now() + 900000).toISOString(),
      absoluteExpiresAt: new Date(Date.now() + 28800000).toISOString(),
    });
  }
  res.writeHead(404);
  res.end();
});
apiOrigin = origin(api);
const assets = await serve((req, res) => {
  assetRequests.push({
    control: req.headers["x-pcu-play-control"],
    cookie: !!req.headers.cookie,
    url: req.url,
  });
  if (req.url.includes(otherToken)) otherRequests++;
  res.writeHead(200, {
    "Content-Type": req.url.endsWith(".js")
      ? "application/javascript"
      : "text/html",
    "Content-Security-Policy": runtimeCsp(assetOrigin, token, apiOrigin),
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cache-Control": "no-store",
  });
  if (req.url.endsWith("worker.js"))
    return res.end(
      `postMessage({isolated:crossOriginIsolated,sab:typeof SharedArrayBuffer==='function'});`,
    );
  res.end(`<!doctype html><title>untrusted fixture</title><script>
 window.probe={isolated:crossOriginIsolated,sab:typeof SharedArrayBuffer==='function',parentBlocked:false};
 try { parent.document.body; } catch { probe.parentBlocked=true; }
 const worker = new Worker('./worker.js');
 worker.onmessage = event => { probe.worker=event.data; };
 worker.onerror = event => { probe.workerError=event.message; };
 </script>`);
});
assetOrigin = origin(assets);
config = {
  API_PUBLIC_URL: apiOrigin,
  WEB_PUBLIC_URL: apiOrigin,
  PUBLIC_ASSET_ORIGIN: assetOrigin,
};
let browser;
try {
  browser = await playwright[engine].launch({
    headless: true,
    timeout: 20000,
    ...(process.env.BROWSER_ENV_FILE
      ? {
          env: {
            ...process.env,
            ...JSON.parse(readFileSync(process.env.BROWSER_ENV_FILE, "utf8")),
          },
        }
      : {}),
    ...(process.env.BROWSER_EXECUTABLE
      ? { executablePath: process.env.BROWSER_EXECUTABLE }
      : {}),
    ...(engine === "chromium" ? { args: ["--no-sandbox"] } : {}),
  });
  const context = await browser.newContext();
  await context.addCookies([
    { name: "fixture_cookie", value: "present", url: assetOrigin },
  ]);
  const page = await context.newPage();
  await page.clock.install();
  await page.goto(`${apiOrigin}/play/projects/1`);
  await page.locator("#game iframe").waitFor();
  assert.equal(await page.locator("#title").textContent(), title);
  assert.equal(await page.locator("#title img").count(), 0);
  assert.equal(await page.evaluate(() => !!window.titleInjected), false);
  const frameElement = page.locator("#game iframe");
  const iframeUrl = await frameElement.getAttribute("src");
  assert.equal(await frameElement.getAttribute("credentialless"), "");
  assert.equal(
    await frameElement.getAttribute("sandbox"),
    "allow-scripts allow-pointer-lock allow-same-origin",
  );
  assert.match(
    await frameElement.getAttribute("allow"),
    /cross-origin-isolated/,
  );
  const game = await (await frameElement.elementHandle()).contentFrame();
  await game.waitForFunction(
    () => window.probe?.worker || window.probe?.workerError,
  );
  const child = await game.evaluate(() => window.probe);
  const parent = await page.evaluate(() => ({
    isolated: crossOriginIsolated,
    sab: typeof SharedArrayBuffer === "function",
  }));
  assert.equal(parent.isolated, true);
  assert.equal(parent.sab, true);
  assert.equal(child.isolated, true);
  assert.equal(child.sab, true);
  assert.equal(child.parentBlocked, true);
  assert.deepEqual(child.worker, { isolated: true, sab: true });
  assert.equal(
    await page.evaluate(() => {
      try {
        document.querySelector("iframe").contentWindow.document.body;
        return false;
      } catch {
        return true;
      }
    }),
    true,
  );
  assert.equal(
    await game.evaluate(
      (secret) => document.documentElement.outerHTML.includes(secret),
      controlSecret,
    ),
    false,
  );
  assert.ok(
    assetRequests.every((r) => !r.control && !r.url.includes(controlSecret)),
  );
  // Override the read-only browser visibility signal to deterministically exercise the handler.
  await page.evaluate(() => {
    window.testVisibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => window.testVisibility,
    });
  });
  const initial = renewals;
  await page.clock.fastForward(60001);
  await page.waitForFunction(
    () => !document.querySelector("#restart").disabled,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(renewals > initial, "visible timer must renew");
  assert.equal(await frameElement.getAttribute("src"), iframeUrl);
  const afterVisible = renewals;
  await page.evaluate(() => {
    window.testVisibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(120000);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(renewals, afterVisible, "hidden timer must not renew");
  // Parent CSP must reject a second runtime directory before network traffic is sent.
  await page.evaluate((url) => {
    const iframe = document.createElement("iframe");
    iframe.id = "blocked-probe";
    iframe.src = url;
    document.body.append(iframe);
  }, `${assetOrigin}/runtime/${otherToken}/index.html`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(otherRequests, 0);
  denyRenew = true;
  await page.evaluate(() => {
    window.testVisibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForFunction(
    () => document.querySelectorAll("#game iframe").length === 0,
  );
  assert.match(await page.locator("#status").textContent(), /만료|변경/);
  assert.equal(await page.locator("#restart").isDisabled(), false);
  console.log(
    JSON.stringify(
      {
        engine,
        version: browser.version(),
        passed: true,
        parent,
        child,
        renewals,
        closes,
        credentiallessSupported: await page.evaluate(
          () => "credentialless" in HTMLIFrameElement.prototype,
        ),
        assetRequestsWithCookie: assetRequests.filter((r) => r.cookie).length,
        limits: [
          "Synthetic Worker/SAB fixture, not Unity",
          "Mock control API, not authenticated acceptance",
          "Hidden state exercised via visibilityState override",
          "Loopback secure context; production TLS/gateway not exercised",
        ],
      },
      null,
      2,
    ),
  );
  await context.close();
} finally {
  await browser?.close();
  await Promise.all(
    [api, assets].map(
      (server) => new Promise((resolve) => server.close(resolve)),
    ),
  );
}
