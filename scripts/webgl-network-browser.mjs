#!/usr/bin/env node
// Real local HTTPS/WSS transport + generated runtime CSP. Synthetic catalog/bundle bytes,
// not Unity Addressables, authenticated approval UI, DNS validation, or production testing.
import assert from "node:assert/strict";
import https from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { runtimeCsp } from "../apps/api/dist/modules/webgl-play/service.js";
const require = createRequire(import.meta.url);
const { WebSocketServer } = require(process.env.WS_MODULE_PATH || "ws");
const playwright = process.env.PLAYWRIGHT_MODULE_PATH
  ? await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href)
  : require("playwright");
const engine = process.env.PLAYWRIGHT_BROWSER || "chromium";
const directory = mkdtempSync(join(tmpdir(), "pcu-network-probe-"));
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(directory, "key.pem"),
    "-out",
    join(directory, "cert.pem"),
    "-days",
    "1",
    "-subj",
    "/CN=*.pcu.test",
    "-addext",
    "subjectAltName=DNS:runtime.pcu.test,DNS:approved.pcu.test,DNS:blocked.pcu.test,DNS:api.pcu.test",
  ],
  { stdio: "ignore" },
);
const token = "a".repeat(64),
  other = "b".repeat(64);
const traffic = [],
  sockets = [];
let base, approved, blocked, api, csp, program;
const server = https.createServer(
  {
    key: readFileSync(join(directory, "key.pem")),
    cert: readFileSync(join(directory, "cert.pem")),
  },
  (req, res) => {
    const host = req.headers.host.split(":")[0],
      path = req.url;
    traffic.push({ host, path, csp: host === "runtime.pcu.test" ? csp : null });
    const common = {
      "Access-Control-Allow-Origin": base,
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Cache-Control": "no-store",
    };
    if (host === "runtime.pcu.test") {
      res.writeHead(200, {
        ...common,
        "Content-Security-Policy": csp,
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Content-Type": path.endsWith(".js")
          ? "application/javascript"
          : "text/html",
      });
      if (path.endsWith("worker.js"))
        return res.end(`${program};probe().then(result=>postMessage(result));`);
      if (path.endsWith("payload")) return res.end("same-runtime");
      return res.end(
        `<!doctype html><script>${program};Promise.all([probe(),new Promise(resolve=>{const worker=new Worker('./worker.js');worker.onmessage=event=>resolve(event.data);worker.onerror=event=>resolve({workerError:event.message});})]).then(([document,worker])=>{window.results={document,worker};});</script>`,
      );
    }
    if (path.startsWith("/redirect")) {
      res.writeHead(302, { ...common, Location: blocked + "/redirect-target" });
      return res.end();
    }
    res.writeHead(200, {
      ...common,
      "Content-Type": path.endsWith(".js")
        ? "application/javascript"
        : "application/json",
    });
    if (path.endsWith(".js"))
      return res.end("globalThis.externalScriptExecuted=true;");
    res.end(
      path.startsWith("/api")
        ? "api-ok"
        : path.startsWith("/catalog")
          ? "catalog-ok"
          : path.startsWith("/hash")
            ? "hash-ok"
            : path.startsWith("/bundle")
              ? "bundle-bytes"
              : "unexpected",
    );
  },
);
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const host = req.headers.host.split(":")[0];
  sockets.push({ host, path: req.url, received: false });
  const record = sockets.at(-1);
  wss.handleUpgrade(req, socket, head, (ws) =>
    ws.on("message", (bytes) => {
      record.received = true;
      ws.send(bytes.toString());
    }),
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
base = `https://runtime.pcu.test:${port}`;
approved = `https://approved.pcu.test:${port}`;
blocked = `https://blocked.pcu.test:${port}`;
api = `https://api.pcu.test:${port}`;
csp = runtimeCsp(base, token, api, [
  approved,
  approved.replace("https:", "wss:"),
]);
assert.ok(
  csp.includes(
    `connect-src ${base}/runtime/${token}/ blob: ${approved} ${approved.replace("https:", "wss:")};`,
  ),
);
const config = { base, approved, blocked, token, other };
program = `const config=${JSON.stringify(config)};
async function probe(){
 const violations=[];addEventListener('securitypolicyviolation',event=>violations.push({directive:event.effectiveDirective,blocked:event.blockedURI}));
 const fetchText=async url=>{try{return await(await fetch(url)).text();}catch{return 'BLOCKED';}};
 const wsEcho=url=>new Promise(resolve=>{try{const ws=new WebSocket(url);let done=false;const finish=value=>{if(done)return;done=true;resolve(value);ws.close();};ws.onopen=()=>ws.send('echo-probe');ws.onmessage=event=>finish(event.data);ws.onerror=()=>finish('BLOCKED');setTimeout(()=>finish('TIMEOUT'),5000);}catch{resolve('BLOCKED');}});
 const output={};
 for(const path of ['api','catalog.json','hash','bundle']) output[path]=await fetchText(config.approved+'/'+path);
 output.same=await fetchText(config.base+'/runtime/'+config.token+'/payload');
 output.otherRuntime=await fetchText(config.base+'/runtime/'+config.other+'/payload');
 output.unapproved=await fetchText(config.blocked+'/fetch');
 output.redirect=await fetchText(config.approved+'/redirect');
 output.wss=await wsEcho(config.approved.replace('https:','wss:')+'/echo');
 output.unapprovedWss=await wsEcho(config.blocked.replace('https:','wss:')+'/echo');
 if(typeof document==='undefined') {try{importScripts(config.approved+'/external.js');output.externalScript='LOADED';}catch{output.externalScript='BLOCKED';}}
 else output.externalScript=await new Promise(resolve=>{const script=document.createElement('script');script.src=config.approved+'/external.js';script.onload=()=>resolve('LOADED');script.onerror=()=>resolve('BLOCKED');document.head.append(script);});
 output.externalWorker=await new Promise(resolve=>{try{const worker=new Worker(config.approved+'/external-worker.js');worker.onerror=()=>{resolve('BLOCKED');worker.terminate();};worker.onmessage=()=>{resolve('LOADED');worker.terminate();};setTimeout(()=>{resolve('TIMEOUT');worker.terminate();},2000);}catch{resolve('BLOCKED');}});
 output.violations=violations;return output;
}`;
let browser;
try {
  browser = await playwright[engine].launch({
    headless: true,
    timeout: 20000,
    ...(process.env.BROWSER_EXECUTABLE
      ? { executablePath: process.env.BROWSER_EXECUTABLE }
      : {}),
    ...(process.env.BROWSER_ENV_FILE
      ? {
          env: {
            ...process.env,
            ...JSON.parse(readFileSync(process.env.BROWSER_ENV_FILE, "utf8")),
          },
        }
      : {}),
    ...(engine === "chromium"
      ? {
          args: [
            "--no-sandbox",
            "--no-proxy-server",
            "--ignore-certificate-errors",
            "--host-resolver-rules=MAP *.pcu.test 127.0.0.1",
          ],
        }
      : {
          firefoxUserPrefs: {
            "network.dns.localDomains":
              "runtime.pcu.test,approved.pcu.test,blocked.pcu.test,api.pcu.test",
            "network.proxy.type": 0,
          },
        }),
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(`${base}/runtime/${token}/index.html`);
  await page.waitForFunction(() => window.results, {}, { timeout: 30000 });
  const results = await page.evaluate(() => window.results);
  for (const [scope, result] of Object.entries(results)) {
    for (const [field, value] of Object.entries({
      api: "api-ok",
      "catalog.json": "catalog-ok",
      hash: "hash-ok",
      bundle: "bundle-bytes",
      same: "same-runtime",
      otherRuntime: "BLOCKED",
      unapproved: "BLOCKED",
      redirect: "BLOCKED",
      wss: "echo-probe",
      unapprovedWss: "BLOCKED",
      externalScript: "BLOCKED",
      externalWorker: "BLOCKED",
    }))
      assert.equal(result[field], value, `${scope}.${field}`);
    assert.ok(
      result.violations.some((v) => v.directive === "connect-src"),
      `${scope} connect-src violation recorded`,
    );
  }
  assert.equal(
    traffic.filter((r) => r.host === "blocked.pcu.test").length,
    0,
    "blocked endpoints never receive HTTP",
  );
  assert.equal(
    traffic.filter((r) => r.path.includes(other)).length,
    0,
    "other runtime directory never receives HTTP",
  );
  assert.equal(
    traffic.filter((r) => r.path.includes("external")).length,
    0,
    "external executable files never fetched",
  );
  assert.equal(
    sockets.filter((r) => r.host === "blocked.pcu.test").length,
    0,
    "unapproved WSS upgrade never sent",
  );
  assert.equal(
    sockets.filter((r) => r.received).length,
    2,
    "document and Worker send real WSS bytes",
  );
  assert.ok(
    traffic
      .filter((r) => r.host === "runtime.pcu.test")
      .every((r) => r.csp === csp),
  );
  console.log(
    JSON.stringify(
      {
        engine,
        version: browser.version(),
        passed: true,
        document: results.document,
        worker: results.worker,
        httpRequests: traffic.length,
        wssEchoes: sockets.filter((r) => r.received).length,
        limits: [
          "Local test DNS mapped to loopback; self-signed TLS trusted for test",
          "Synthetic catalog/hash/bundle transport, not Unity Addressables",
          "Generated CSP with approved origin snapshot; approval persistence/auth tested separately",
          "No request interception or socket mocking",
        ],
      },
      null,
      2,
    ),
  );
  await context.close();
} finally {
  await browser?.close();
  for (const client of wss.clients) client.terminate();
  wss.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(directory, { recursive: true, force: true });
}
