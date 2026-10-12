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
import { sanitizeConnectionReport } from '../apps/api/dist/modules/webgl-play/diagnostics.js';
import { runtimeCsp } from "../apps/api/dist/modules/webgl-play/service.js";
const require = createRequire(import.meta.url);
const { WebSocketServer } = require(process.env.WS_MODULE_PATH || "ws");
const playwright = process.env.PLAYWRIGHT_MODULE_PATH
  ? await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href)
  : require("playwright");
const engine = process.env.PLAYWRIGHT_BROWSER || "chromium";
const directory = mkdtempSync(join(tmpdir(), "pcu-network-probe-"));
if (!process.env.BROWSER_TLS_CERT_PATH) execFileSync(
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
    "/CN=*.pcu.example.com",
    "-addext",
    "subjectAltName=DNS:runtime.pcu.example.com,DNS:region.approved.pcu.example.com,DNS:blocked.pcu.example.com,DNS:api.pcu.example.com,DNS:game.approved.pcu.example.com,DNS:approved.pcu.example.com",
  ],
  { stdio: "ignore" },
);
const certPath = process.env.BROWSER_TLS_CERT_PATH || join(directory, "cert.pem");
const keyPath = process.env.BROWSER_TLS_KEY_PATH || join(directory, "key.pem");
const token = "a".repeat(64),
  other = "b".repeat(64);
const reports = [];
const traffic = [],
  sockets = [];
let base, approved, blocked, api, csp, program;
const server = https.createServer(
  {
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
  },
  (req, res) => {
    const host = req.headers.host.split(":")[0],
      path = req.url;
    if (host === 'api.pcu.example.com' && path === '/report' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => { const item = sanitizeConnectionReport(JSON.parse(body)); if (item) reports.push(item); res.writeHead(204); res.end(); });
      return;
    }
    traffic.push({ host, port: req.socket.localPort, path, csp: host === "runtime.pcu.example.com" ? csp : null });
    const common = {
      "Access-Control-Allow-Origin": base,
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Cache-Control": "no-store",
    };
    if (host === "runtime.pcu.example.com") {
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
    if (path === '/cors-denied') { res.writeHead(200, { 'Cross-Origin-Resource-Policy': 'cross-origin' }); return res.end('cors-denied'); }
    if (path === '/auth-denied') { res.writeHead(401, common); return res.end('authentication-denied'); }
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
  sockets.push({ host, port: req.socket.localPort, path: req.url, received: false });
  const record = sockets.at(-1);
  if (req.url === '/origin-denied' || req.headers.origin !== base) { socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return; }
  if (req.url === '/auth-denied') { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return; }
  wss.handleUpgrade(req, socket, head, (ws) =>
    ws.on("message", (bytes) => {
      record.received = true;
      ws.send(bytes.toString());
    }),
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
base = `https://runtime.pcu.example.com:${port}`;
approved = `https://region.approved.pcu.example.com:${port}`;
blocked = `https://blocked.pcu.example.com:${port}`;
api = `https://api.pcu.example.com:${port}`;
// A second real TLS listener on the same host distinguishes port permission
// from hostname permission. Both listeners use identical HTTPS and WSS handlers.
const secondServer = https.createServer({
  key: readFileSync(keyPath),
  cert: readFileSync(certPath),
}, server.listeners('request')[0]);
secondServer.on('upgrade', server.listeners('upgrade')[0]);
await new Promise(resolve => secondServer.listen(0, '127.0.0.1', resolve));
const secondPort = secondServer.address().port;
assert.notEqual(port, secondPort);
const config = { base, approved, secondApproved: approved.replace(`:${port}`, `:${secondPort}`), blocked, token, other };
program = `const config=${JSON.stringify(config)};
async function probe(){
 const violations=[];addEventListener('securitypolicyviolation',event=>violations.push({directive:event.effectiveDirective,blocked:event.blockedURI}));
 const fetchText=async url=>{try{return await(await fetch(url)).text();}catch{return 'BLOCKED';}};
 const wsEcho=url=>new Promise(resolve=>{try{const ws=new WebSocket(url);let done=false;const finish=value=>{if(done)return;done=true;resolve(value);ws.close();};ws.onopen=()=>ws.send('echo-probe');ws.onmessage=event=>finish(event.data);ws.onerror=()=>finish('BLOCKED');setTimeout(()=>finish('TIMEOUT'),5000);}catch{resolve('BLOCKED');}});
 const output={};
 for(const path of ['api','catalog.json','hash','bundle']) output[path]=await fetchText(config.approved+'/'+path);
 output.corsDenied=await fetchText(config.approved+'/cors-denied');
 output.authDenied=await fetchText(config.approved+'/auth-denied');
 output.originDenied=await wsEcho(config.approved.replace('https:','wss:')+'/origin-denied');
 output.socketAuthDenied=await wsEcho(config.approved.replace('https:','wss:')+'/auth-denied');
 output.same=await fetchText(config.base+'/runtime/'+config.token+'/payload');
 output.otherRuntime=await fetchText(config.base+'/runtime/'+config.other+'/payload');
 output.unapproved=await fetchText(config.blocked+'/fetch');
 output.redirect=await fetchText(config.approved+'/redirect');
 output.wss=await wsEcho(config.approved.replace('https:','wss:')+'/echo');
 output.secondHttps=await fetchText(config.secondApproved+'/api');
 output.secondWss=await wsEcho(config.secondApproved.replace('https:','wss:')+'/echo');
 output.serverMove=await wsEcho(config.approved.replace('https:','wss:').replace('region.approved','game.approved')+'/echo');
 output.secondServerMove=await wsEcho(config.secondApproved.replace('https:','wss:').replace('region.approved','game.approved')+'/echo');
 output.wildcardRootHttps=await fetchText(config.approved.replace('region.approved','approved')+'/api');
 output.wildcardRoot=await wsEcho(config.approved.replace('https:','wss:').replace('region.approved','approved')+'/echo');
 output.unapprovedWss=await wsEcho(config.blocked.replace('https:','wss:')+'/echo');
 if(typeof document==='undefined') {try{importScripts(config.approved+'/external.js');output.externalScript='LOADED';}catch{output.externalScript='BLOCKED';}}
 else output.externalScript=await new Promise(resolve=>{const script=document.createElement('script');script.src=config.approved+'/external.js';script.onload=()=>resolve('LOADED');script.onerror=()=>resolve('BLOCKED');document.head.append(script);});
 output.externalWorker=await new Promise(resolve=>{try{const worker=new Worker(config.approved+'/external-worker.js');worker.onerror=()=>{resolve('BLOCKED');worker.terminate();};worker.onmessage=()=>{resolve('LOADED');worker.terminate();};setTimeout(()=>{resolve('TIMEOUT');worker.terminate();},2000);}catch{resolve('BLOCKED');}});
 output.violations=violations;return output;
}`;
let browser;
try {
  // Firefox reads trust anchors from its isolated profile; Chromium uses the
  // isolated runner's NSS DB, WebKit its system CA store. TLS checks stay enabled.
  const firefoxProfile = join(directory, 'firefox-profile');
  if (engine === 'firefox') {
    execFileSync('mkdir', ['-p', firefoxProfile]);
    execFileSync(process.env.CERTUTIL || 'certutil', ['-N', '--empty-password', '-d', `sql:${firefoxProfile}`]);
    execFileSync(process.env.CERTUTIL || 'certutil', ['-A', '-d', `sql:${firefoxProfile}`, '-n', 'pcu-test-ca', '-t', 'C,,', '-i', process.env.BROWSER_TLS_CA_PATH || certPath]);
  }
  const launchOptions = {
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
            "--host-resolver-rules=MAP *.pcu.example.com 127.0.0.1",
          ],
        }
      : {
          firefoxUserPrefs: {
            "network.dns.localDomains":
              "runtime.pcu.example.com,region.approved.pcu.example.com,game.approved.pcu.example.com,approved.pcu.example.com,blocked.pcu.example.com,api.pcu.example.com",
            "network.proxy.type": 0,
          },
        }),
  };
  const firefoxContext = engine === 'firefox'
    ? await playwright.firefox.launchPersistentContext(firefoxProfile, launchOptions) : null;
  browser = firefoxContext ? firefoxContext.browser() : await playwright[engine].launch(launchOptions);
  for (const policy of ['fixed-port', 'exact-all-ports', 'subdomain-all-ports']) {
    reports.length = 0; traffic.length = 0; sockets.length = 0;
    const allPorts = policy !== 'fixed-port';
    const subdomains = policy !== 'exact-all-ports';
    const httpsSource = allPorts ? approved.replace(`:${port}`, ':*') : approved;
    const wssSource = httpsSource.replace('https:', 'wss:');
    const rules = [
      policy === 'subdomain-all-ports' ? httpsSource.replace('region.approved', '*.approved') : httpsSource,
      subdomains ? wssSource.replace('region.approved', '*.approved') : wssSource,
    ];
    csp = runtimeCsp(base, token, api, rules, api + '/report');
    assert.ok(csp.includes(`connect-src ${base}/runtime/${token}/ blob: ${rules.join(' ')};`));
    const context = firefoxContext || await browser.newContext();
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
        corsDenied: "BLOCKED",
        authDenied: "authentication-denied",
        originDenied: "BLOCKED",
        socketAuthDenied: "BLOCKED",
        same: "same-runtime",
        otherRuntime: "BLOCKED",
        unapproved: "BLOCKED",
        redirect: "BLOCKED",
        wss: "echo-probe",
        secondHttps: allPorts ? 'api-ok' : 'BLOCKED',
        secondWss: allPorts ? 'echo-probe' : 'BLOCKED',
        serverMove: subdomains ? 'echo-probe' : 'BLOCKED',
        secondServerMove: allPorts && subdomains ? 'echo-probe' : 'BLOCKED',
        wildcardRootHttps: 'BLOCKED',
        wildcardRoot: "BLOCKED",
        unapprovedWss: "BLOCKED",
        externalScript: "BLOCKED",
        externalWorker: "BLOCKED",
      }))
        assert.equal(result[field], value, `${policy}.${scope}.${field}`);
      // WebKit enforces Worker CSP but may omit Worker violation events.
      if (!(engine === 'webkit' && scope === 'worker')) assert.ok(
        result.violations.some((v) => v.directive === "connect-src"),
        `${scope} connect-src violation recorded`,
      );
    }
    assert.equal(
      traffic.filter((r) => r.host === "blocked.pcu.example.com").length,
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
      sockets.filter((r) => r.host === "blocked.pcu.example.com").length,
      0,
      "unapproved WSS upgrade never sent",
    );
    assert.equal(traffic.filter(r => r.host === 'approved.pcu.example.com').length, 0, 'root host receives no HTTP');
    assert.equal(sockets.filter(r => r.host === 'approved.pcu.example.com').length, 0, 'root host receives no WSS upgrade');
    assert.equal(
      sockets.filter((r) => r.received).length,
      2 * (1 + Number(subdomains) + Number(allPorts) + Number(allPorts && subdomains)),
      "document and Worker WSS echoes match the hostname and port policy",
    );
    for (const targetPort of [port, secondPort]) {
      const allowed = targetPort === port || allPorts;
      assert.equal(traffic.filter(r => r.host === 'region.approved.pcu.example.com' && r.port === targetPort && r.path === '/api').length, allowed ? 2 : 0, `${policy}: HTTPS server observations on ${targetPort}`);
      assert.equal(sockets.filter(r => r.host === 'region.approved.pcu.example.com' && r.port === targetPort && r.received).length, allowed ? 2 : 0, `${policy}: WSS server observations on ${targetPort}`);
    }
    if (!allPorts) {
      assert.equal(traffic.filter(r => r.port === secondPort).length, 0, 'fixed port blocks all second-port HTTP');
      assert.equal(sockets.filter(r => r.port === secondPort).length, 0, 'fixed port blocks second-port upgrades');
    }
    assert.ok(
      traffic
        .filter((r) => r.host === "runtime.pcu.example.com")
        .every((r) => r.csp === csp),
    );
    await page.waitForTimeout(1500);
    assert.ok(reports.some(report => report.origin === blocked && report.directive === 'connect-src'), 'CSP report-uri received blocked connection');
    assert.ok(reports.every(report => !report.origin.includes('/fetch')), 'only origins retained');
    console.log(
      JSON.stringify(
        {
          engine,
          policy,
          ports: [port, secondPort],
          rules,
          version: browser.version(),
          passed: true,
          document: results.document,
          worker: results.worker,
          receivedDiagnostics: reports,
          httpRequests: traffic.length,
          wssEchoes: sockets.filter((r) => r.received).length,
          limits: [
            "Local test DNS mapped to loopback; isolated test CA trusted with TLS verification enabled",
            "Synthetic catalog/hash/bundle transport, not Unity Addressables",
            "Generated CSP with approved origin snapshot; approval persistence/auth tested separately",
            "No request interception or socket mocking",
            ...(engine === "webkit" ? ["WebKit Worker CSP violation events may be absent; transport enforcement and report-uri delivery checked separately"] : []),
          ],
        },
        null,
        2,
      ),
    );
    if (!firefoxContext) await context.close(); else await page.close();
  }
} finally {
  await browser?.close();
  for (const client of wss.clients) client.terminate();
  wss.close();
  await Promise.all([server, secondServer].map(listener => new Promise(resolve => listener.close(resolve))));
  rmSync(directory, { recursive: true, force: true });
}
