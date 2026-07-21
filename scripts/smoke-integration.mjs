import { request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { brotliCompressSync, gzipSync } from 'node:zlib';

const apiBase = process.env.INTEGRATION_API_BASE_URL || 'http://localhost:4000';
const webBase = process.env.INTEGRATION_WEB_BASE_URL || 'http://localhost:5173';
const origin = process.env.INTEGRATION_ORIGIN || webBase;
const webglFixturePath = process.env.INTEGRATION_WEBGL_ZIP;
const keepWebgl = process.env.INTEGRATION_KEEP_WEBGL === 'true';

const timeoutMs = Number(process.env.INTEGRATION_SMOKE_TIMEOUT_MS || 180_000);
const pollIntervalMs = 2_000;

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(name, fn) {
  const started = Date.now();
  let lastError;

  while (Date.now() - started < timeoutMs) {
    try {
      const result = await fn();
      console.log(`ok: ${name}`);
      return result;
    } catch (err) {
      lastError = err;
      await sleep(pollIntervalMs);
    }
  }

  throw new Error(`${name} did not become ready: ${lastError?.message || lastError}`);
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!res.ok) {
    throw new Error(`${options?.method || 'GET'} ${url} returned ${res.status}: ${text}`);
  }
  return { res, body };
}

async function fetchIntegrationS3Headers(url) {
  const target = new URL(url);
  const signedHost = target.host;
  const apiHostname = new URL(apiBase).hostname;
  if (target.hostname === 'garage' && (apiHostname === 'localhost' || apiHostname === '127.0.0.1')) {
    target.hostname = '127.0.0.1';
  }

  return new Promise((resolve, reject) => {
    const request = httpRequest(target, { headers: { Host: signedHost } }, (response) => {
      resolve({ status: response.statusCode ?? 0, headers: response.headers });
      response.destroy();
    });
    request.on('error', reject);
    request.end();
  });
}

function integrationApiUrl(url) {
  const target = new URL(url);
  const internalApi = new URL(apiBase);
  if (
    (target.hostname === 'localhost' || target.hostname === '127.0.0.1')
    && internalApi.hostname !== 'localhost'
    && internalApi.hostname !== '127.0.0.1'
  ) {
    target.protocol = internalApi.protocol;
    target.host = internalApi.host;
  }
  return target.toString();
}

function crc32(input) {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Create a small standards-compliant ZIP with stored entries for integration uploads. */
function makeStoredZip(files) {
  const locals = [];
  const centrals = [];
  let localOffset = 0;

  for (const [fileName, rawBody] of files) {
    const name = Buffer.from(fileName, 'utf8');
    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
    const checksum = crc32(body);
    const local = Buffer.alloc(30 + name.length + body.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    body.copy(local, 30 + name.length);
    locals.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centrals.push(central);
    localOffset += local.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}

await waitFor('API health', async () => {
  const { body } = await fetchJson(`${apiBase}/api/health`);
  if (!body?.ok) throw new Error('health returned ok=false');
});

await waitFor('Web root', async () => {
  const res = await fetch(webBase);
  if (!res.ok) throw new Error(`web returned ${res.status}`);
});

const { body: years } = await fetchJson(`${apiBase}/api/public/years`);
if (!years?.ok || !Array.isArray(years.data?.items)) {
  throw new Error('/api/public/years did not return the expected envelope');
}
if (!years.data.items.some((item) => item.title === 'Integration Upload Open')) {
  throw new Error('integration seed exhibition is missing from /api/public/years');
}
console.log('ok: public years include integration seed');

const { res: loginRes, body: loginBody } = await fetchJson(`${apiBase}/api/dev/auth/login`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Origin: origin,
  },
  body: JSON.stringify({ role: 'ADMIN' }),
});
if (loginBody?.data?.user?.role !== 'ADMIN') {
  throw new Error('dev login did not return ADMIN user');
}

const cookie = loginRes.headers.get('set-cookie')?.split(';')[0];
if (!cookie?.startsWith('sid=')) {
  throw new Error('dev login did not set the sid cookie');
}
console.log('ok: dev auth login');

const { body: me } = await fetchJson(`${apiBase}/api/me`, {
	headers: { Cookie: cookie, Origin: origin },
});
if (!me?.data?.authenticated || me.data.user.role !== 'ADMIN') {
  throw new Error('/api/me did not resolve the dev-auth session');
}
console.log('ok: session cookie resolves through /api/me');

const { body: untrustedMe } = await fetchJson(`${apiBase}/api/me`, {
  headers: { Cookie: cookie, Origin: new URL(apiBase).origin },
});
if (untrustedMe?.data?.authenticated) {
  throw new Error('API/WebGL-origin request unexpectedly reused the frontend session');
}
console.log('ok: API/WebGL-origin requests cannot reuse frontend sessions');

const assetRes = await fetch(`${apiBase}/api/assets/public/integration-poster.png`, {
  redirect: 'manual',
});
if (assetRes.status !== 302) {
  throw new Error(`asset redirect returned ${assetRes.status}`);
}
const location = assetRes.headers.get('location');
if (!location || !location.includes('integration-poster.png')) {
  throw new Error('asset redirect did not include the expected presigned URL');
}
console.log('ok: public asset redirect');

const { body: publicProject } = await fetchJson(
  `${apiBase}/api/public/projects/integration-public-asset`,
);
const gameDownloadUrl = publicProject?.data?.gameDownloadUrl;
if (typeof gameDownloadUrl !== 'string') {
  throw new Error('integration public project did not expose a game download URL');
}

const gameRedirect = await fetch(integrationApiUrl(gameDownloadUrl), { redirect: 'manual' });
if (gameRedirect.status !== 302) {
  throw new Error(`game download redirect returned ${gameRedirect.status}`);
}
const gameLocation = gameRedirect.headers.get('location');
if (!gameLocation) throw new Error('game download redirect did not include a presigned URL');

const gameObject = await fetchIntegrationS3Headers(gameLocation);
if (gameObject.status < 200 || gameObject.status >= 300) {
  throw new Error(`presigned game download returned ${gameObject.status}`);
}
const disposition = gameObject.headers['content-disposition'] || '';
const expectedFilename =
  "filename*=UTF-8''Integration%20Public%20Asset%20Project_Integration%20Student_20260001.zip";
if (!disposition.includes('filename="game.zip"') || !disposition.includes(expectedFilename)) {
  throw new Error(`game download returned unexpected Content-Disposition: ${disposition}`);
}
console.log('ok: game download uses the friendly Content-Disposition filename');

const projectId = publicProject?.data?.id;
if (!Number.isInteger(projectId)) throw new Error('integration public project did not expose a numeric ID');

const gameProbeZip = makeStoredZip([['readme.txt', 'independent GAME session']]);
const wasmBody = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const wasmBr = brotliCompressSync(wasmBody);
const dataGz = gzipSync(Buffer.from('integration Unity data'));
const syntheticWebglZip = makeStoredZip([
  ['UnityBuild/index.html', '<!doctype html><meta charset="utf-8"><title>Integration WebGL</title>'],
  ['UnityBuild/Build/integration.wasm.br', wasmBr],
  ['UnityBuild/Build/integration.data.gz', dataGz],
  ['UnityBuild/TemplateData/style.css', 'html,body{margin:0;background:#000}'],
]);
const webglZip = webglFixturePath ? await readFile(webglFixturePath) : syntheticWebglZip;
const webglIndexMarker = process.env.INTEGRATION_WEBGL_INDEX_MARKER
  || (webglFixturePath ? 'WebLoadingTest' : 'Integration WebGL');
const webglWasmPath = process.env.INTEGRATION_WEBGL_WASM_PATH
  || 'Build/integration.wasm.br';

if (webglFixturePath) {
  console.log(`using external WebGL fixture: ${webglFixturePath} (${webglZip.length} bytes)`);
}

async function createUploadSession(originalName, body, uploadKind) {
  const { body: response } = await fetchJson(
    `${apiBase}/api/admin/projects/${projectId}/game-upload-sessions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: origin,
      },
      body: JSON.stringify({ originalName, totalBytes: body.length, uploadKind }),
    },
  );
  return response?.data;
}

const gameSession = await createUploadSession('game-probe.zip', gameProbeZip, 'GAME');
const webglSession = await createUploadSession('webgl.zip', webglZip, 'WEBGL');
if (gameSession?.uploadKind !== 'GAME' || webglSession?.uploadKind !== 'WEBGL') {
  throw new Error('upload sessions did not preserve independent upload kinds');
}

const { body: activeSessions } = await fetchJson(
	`${apiBase}/api/admin/projects/${projectId}/game-upload-sessions`,
	{ headers: { Cookie: cookie, Origin: origin } },
);
const activeKinds = new Set(activeSessions?.data?.items?.map((item) => item.uploadKind));
if (!activeKinds.has('GAME') || !activeKinds.has('WEBGL')) {
  throw new Error('GAME and WEBGL sessions did not coexist for one project');
}
console.log('ok: GAME and WEBGL upload sessions coexist independently');

const missingChunkComplete = await fetch(
  `${apiBase}/api/admin/game-upload-sessions/${gameSession.sessionId}/complete`,
  { method: 'POST', headers: { Cookie: cookie, Origin: origin } },
);
if (missingChunkComplete.status !== 400) {
  throw new Error(`missing-chunk completion returned ${missingChunkComplete.status}`);
}
const missingChunkBody = await missingChunkComplete.json();
if (missingChunkBody?.error?.code !== 'ERROR') {
  throw new Error('missing-chunk completion did not preserve the existing ERROR envelope');
}
console.log('ok: completion rejects sessions with missing chunks');

await fetchJson(`${apiBase}/api/admin/game-upload-sessions/${gameSession.sessionId}`, {
  method: 'DELETE',
  headers: { Cookie: cookie, Origin: origin },
});

await fetchJson(
  `${apiBase}/api/admin/game-upload-sessions/${webglSession.sessionId}/chunks/0`,
  {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      Cookie: cookie,
      Origin: origin,
    },
    body: webglZip,
  },
);
const completionUrl = `${apiBase}/api/admin/game-upload-sessions/${webglSession.sessionId}/complete`;
const completionOptions = { method: 'POST', headers: { Cookie: cookie, Origin: origin } };
const completionResponses = await Promise.all([
  fetch(completionUrl, completionOptions),
  fetch(completionUrl, completionOptions),
]);
const completionStatuses = completionResponses.map((response) => response.status).sort((a, b) => a - b);
if (completionStatuses[0] !== 200 || completionStatuses[1] !== 400) {
  throw new Error(`concurrent completion returned ${completionStatuses.join(', ')}`);
}
const successfulCompletion = completionResponses.find((response) => response.status === 200);
const rejectedCompletion = completionResponses.find((response) => response.status === 400);
const webglComplete = await successfulCompletion.json();
const duplicateComplete = await rejectedCompletion.json();
if (duplicateComplete?.error?.code !== 'ERROR') {
  throw new Error('duplicate completion did not preserve the existing ERROR envelope');
}
console.log('ok: concurrent completion has exactly one winner');
const webglUrl = webglComplete?.data?.webglUrl;
if (typeof webglUrl !== 'string') throw new Error('WebGL completion did not return webglUrl');
const hostedWebglUrl = integrationApiUrl(webglUrl);

const hostedIndex = await fetch(hostedWebglUrl, { headers: { Origin: 'null' } });
if (!hostedIndex.ok || !(await hostedIndex.text()).includes(webglIndexMarker)) {
  throw new Error(`anonymous WebGL index returned ${hostedIndex.status}`);
}
if (hostedIndex.headers.get('access-control-allow-origin') !== '*') {
  throw new Error('WebGL index did not use credential-free CORS');
}
if (hostedIndex.headers.has('access-control-allow-credentials')) {
  throw new Error('WebGL index unexpectedly allowed credentials');
}
if (hostedIndex.headers.has('x-frame-options')) {
  throw new Error('WebGL index retained the global iframe denial header');
}
const webglCsp = hostedIndex.headers.get('content-security-policy') || '';
if (!webglCsp.includes(`frame-ancestors ${new URL(origin).origin}`)) {
  throw new Error(`WebGL index returned an unexpected CSP: ${webglCsp}`);
}
// The container reaches the API as `http://api:4000`, while generated public
// URLs intentionally use the browser-facing API_PUBLIC_URL (`localhost`). CSP
// must be asserted against the wire contract, not the test runner's route.
const webglAssetSource = `${new URL(webglUrl).origin}/api/public/webgl/`;
if (!webglCsp.includes(`connect-src ${webglAssetSource}`) || webglCsp.includes("connect-src 'self'")) {
  throw new Error(`WebGL index did not isolate asset connections: ${webglCsp}`);
}

const hostedWasm = await fetch(new URL(webglWasmPath, hostedWebglUrl), {
  headers: { Origin: 'null', Range: 'bytes=0-7' },
});
if (hostedWasm.status !== 206) {
  throw new Error(`WebGL WASM range returned ${hostedWasm.status}`);
}
if (hostedWasm.headers.get('content-type') !== 'application/wasm') {
  throw new Error(`WebGL WASM returned ${hostedWasm.headers.get('content-type')}`);
}
if (hostedWasm.headers.get('content-encoding') !== 'br') {
  throw new Error('WebGL WASM did not preserve Brotli Content-Encoding');
}
if (!hostedWasm.headers.get('content-range')?.startsWith('bytes 0-')) {
  throw new Error('WebGL WASM did not return Content-Range');
}
await hostedWasm.arrayBuffer();
console.log('ok: WebGL ZIP deploys and streams anonymously with CSP/CORS/Range/encoding');

if (keepWebgl) {
  console.log(`ok: retained WebGL fixture for browser checks at ${hostedWebglUrl}`);
} else {
  await fetchJson(`${apiBase}/api/admin/projects/${projectId}/webgl`, {
    method: 'DELETE',
    headers: { Cookie: cookie, Origin: origin },
  });
  const deletedWebgl = await fetch(hostedWebglUrl, { headers: { Origin: 'null' } });
  if (deletedWebgl.status !== 404) {
    throw new Error(`deleted WebGL deployment remained public with ${deletedWebgl.status}`);
  }
  const { body: projectAfterWebglDelete } = await fetchJson(
    `${apiBase}/api/public/projects/integration-public-asset`,
  );
  if (projectAfterWebglDelete?.data?.webglUrl !== undefined) {
    throw new Error('deleted WebGL pointer remained in public project detail');
  }
  if (typeof projectAfterWebglDelete?.data?.gameDownloadUrl !== 'string') {
    throw new Error('deleting WebGL also removed the independent GAME download');
  }
  console.log('ok: deleting WebGL preserves the independent GAME download');
}

console.log('integration smoke passed');
