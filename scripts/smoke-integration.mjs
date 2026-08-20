import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { brotliCompressSync, gzipSync } from 'node:zlib';

const apiBase = process.env.INTEGRATION_API_BASE_URL || 'http://localhost:4000';
const webBase = process.env.INTEGRATION_WEB_BASE_URL || 'http://localhost:5173';
const origin = process.env.INTEGRATION_ORIGIN || webBase;
const webglFixturePath = process.env.INTEGRATION_WEBGL_ZIP;
const keepWebgl = process.env.INTEGRATION_KEEP_WEBGL === 'true';

const timeoutMs = Number(process.env.INTEGRATION_SMOKE_TIMEOUT_MS || 180_000);
const pollIntervalMs = 2_000;
const SOURCE_IDENTITY_BLOCK_SIZE_BYTES = 1_048_576;
const SOURCE_IDENTITY_ALGORITHM = 'SHA256_BLOCK_MANIFEST_V1';
const SOURCE_IDENTITY_ROOT_PREFIX = Buffer.from('PCU-UPLOAD-SOURCE-V1\0', 'utf8');

function sourceIdentityForBytes(bytes) {
  const sourceIdentityBlockDigests = [];
  const digestBuffers = [];
  for (let offset = 0; offset < bytes.length; offset += SOURCE_IDENTITY_BLOCK_SIZE_BYTES) {
    const digest = createHash('sha256')
      .update(bytes.subarray(offset, offset + SOURCE_IDENTITY_BLOCK_SIZE_BYTES))
      .digest();
    digestBuffers.push(digest);
    sourceIdentityBlockDigests.push(digest.toString('hex'));
  }
  const header = Buffer.alloc(16);
  header.writeBigUInt64BE(BigInt(bytes.length), 0);
  header.writeUInt32BE(SOURCE_IDENTITY_BLOCK_SIZE_BYTES, 8);
  header.writeUInt32BE(digestBuffers.length, 12);
  return {
    sourceIdentityAlgorithm: SOURCE_IDENTITY_ALGORITHM,
    sourceIdentity: createHash('sha256')
      .update(SOURCE_IDENTITY_ROOT_PREFIX)
      .update(header)
      .update(Buffer.concat(digestBuffers))
      .digest('hex'),
    sourceIdentityBlockSizeBytes: SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
    sourceIdentityBlockDigests,
  };
}

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

function resolveIntegrationS3Target(url) {
  const target = new URL(url);
  const signedHost = target.host;
  const apiHostname = new URL(apiBase).hostname;
  // The API deliberately signs the browser-visible localhost endpoint while
  // this smoke client runs in a sibling container.  Connect to Garage over the
  // Compose network but preserve the signed Host header byte-for-byte.
  if (
    (target.hostname === 'localhost' || target.hostname === '127.0.0.1')
    && apiHostname !== 'localhost'
    && apiHostname !== '127.0.0.1'
  ) {
    target.hostname = 'garage';
  } else if (target.hostname === 'garage' && (apiHostname === 'localhost' || apiHostname === '127.0.0.1')) {
    target.hostname = '127.0.0.1';
  }

  return { target, signedHost };
}

async function requestIntegrationS3(url, {
  method = 'GET',
  headers = {},
  body,
} = {}) {
  const { target, signedHost } = resolveIntegrationS3Target(url);

  return new Promise((resolve, reject) => {
    const request = httpRequest(target, {
      method,
      headers: { ...headers, Host: signedHost },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function fetchIntegrationS3Headers(url) {
  return requestIntegrationS3(url);
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

const publicImageUrl = `${apiBase}/api/public/images/integration-poster.png`;
const assetRes = await fetch(publicImageUrl, { redirect: 'manual' });
if (assetRes.status !== 200) {
  throw new Error(`public image stream returned ${assetRes.status}`);
}
if (!assetRes.headers.get('content-type')?.includes('image/png')) {
  throw new Error('public image stream returned an unexpected Content-Type');
}
if (assetRes.headers.get('cache-control') !== 'public, max-age=31536000, immutable') {
  throw new Error('public image stream did not return the immutable cache policy');
}
if ((await assetRes.arrayBuffer()).byteLength === 0) {
  throw new Error('public image stream returned an empty body');
}

const assetHead = await fetch(publicImageUrl, { method: 'HEAD' });
if (assetHead.status !== 200 || !assetHead.headers.get('content-length')) {
  throw new Error(`public image HEAD returned invalid metadata (${assetHead.status})`);
}
const imageEtag = assetHead.headers.get('etag');
if (imageEtag) {
  const conditional = await fetch(publicImageUrl, {
    headers: { 'If-None-Match': imageEtag },
  });
  if (conditional.status !== 304 || (await conditional.arrayBuffer()).byteLength !== 0) {
    throw new Error('public image conditional request did not return a bodyless 304');
  }
}
console.log('ok: public image direct stream, HEAD, and immutable cache');

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
  ['UnityBuild/Build/integration.loader.js', 'createUnityInstance()'],
  ['UnityBuild/Build/integration.framework.js', 'var unityFramework = true;'],
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
	const sourceIdentity = sourceIdentityForBytes(body);
  const { body: response } = await fetchJson(
    `${apiBase}/api/admin/projects/${projectId}/game-upload-sessions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: origin,
      },
      body: JSON.stringify({ originalName, totalBytes: body.length, uploadKind, ...sourceIdentity }),
    },
  );
  return response?.data;
}

function assertDirectMultipartSession(session, uploadKind) {
  if (session?.uploadKind !== uploadKind
    || session.transport !== 'DIRECT_MULTIPART'
    || !Number.isSafeInteger(session.generation)
    || session.generation < 1
    || !Number.isSafeInteger(session.totalChunks)
    || session.totalChunks < 1
    || !Number.isSafeInteger(session.chunkSizeBytes)
    || session.chunkSizeBytes < 1) {
    throw new Error(`${uploadKind} session did not negotiate DIRECT_MULTIPART`);
  }
}

/**
 * Browser-equivalent direct UploadPart transport.  This intentionally has no
 * API chunk route: changing a direct session into an API byte relay would
 * invalidate the control-plane boundary this smoke test protects.
 */
async function uploadDirectMultipart(session, bytes) {
  assertDirectMultipartSession(session, session.uploadKind);
  const parts = [];
  const partNumbers = Array.from({ length: session.totalChunks }, (_, index) => index + 1);

  for (let offset = 0; offset < partNumbers.length; offset += 8) {
    const requestedPartNumbers = partNumbers.slice(offset, offset + 8);
    const { body: signedResponse } = await fetchJson(
      `${apiBase}/api/admin/game-upload-sessions/${session.sessionId}/part-urls`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          Origin: origin,
        },
        body: JSON.stringify({ generation: session.generation, partNumbers: requestedPartNumbers }),
      },
    );
    const signed = signedResponse?.data;
    if (signed?.generation !== session.generation || !Array.isArray(signed.parts)) {
      throw new Error('part-urls response did not preserve the direct session generation');
    }
    const capabilities = new Map(signed.parts.map((part) => [part.partNumber, part]));
    if (capabilities.size !== requestedPartNumbers.length
      || requestedPartNumbers.some((partNumber) => !capabilities.has(partNumber))) {
      throw new Error('part-urls response did not contain exactly the requested parts');
    }

    for (const partNumber of requestedPartNumbers) {
      const capability = capabilities.get(partNumber);
      const start = (partNumber - 1) * session.chunkSizeBytes;
      const partBody = bytes.subarray(start, Math.min(start + session.chunkSizeBytes, bytes.length));
      const put = await requestIntegrationS3(capability.url, {
        method: 'PUT',
        headers: {
          Origin: origin,
          ...capability.requiredHeaders,
        },
        body: partBody,
      });
      const etag = put.headers.etag;
      if (put.status !== 200 || typeof etag !== 'string' || !etag) {
        throw new Error(`direct UploadPart ${partNumber} failed (${put.status}; ETag=${String(etag)})`);
      }
      parts.push({ partNumber, etag, sizeBytes: partBody.length });
    }
  }

  return { generation: session.generation, parts };
}

async function completeDirectSession(session, manifest) {
  const completionUrl = `${apiBase}/api/admin/game-upload-sessions/${session.sessionId}/complete`;
  const response = await fetch(completionUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      Origin: origin,
    },
    body: JSON.stringify(manifest),
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body };
}

async function waitForDirectCompletion(session, manifest) {
  return waitFor(`${session.uploadKind} validation`, async () => {
    const { body: statusResponse } = await fetchJson(
      `${apiBase}/api/admin/game-upload-sessions/${session.sessionId}`,
      { headers: { Cookie: cookie, Origin: origin } },
    );
    const status = statusResponse?.data;
    if (status?.status === 'COMPLETED') {
      const completed = await completeDirectSession(session, manifest);
      if (completed.response.status !== 200 || completed.body?.data?.status !== 'COMPLETED') {
        throw new Error(`completed direct session did not return its idempotent result (${completed.response.status})`);
      }
      return completed.body.data;
    }
    if (['REJECTED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(status?.status)) {
      throw new Error(`direct ${session.uploadKind} session reached terminal ${status.status}`);
    }
    throw new Error(`direct ${session.uploadKind} session is still ${status?.status ?? 'unknown'}`);
  });
}

const gameSession = await createUploadSession('game-probe.zip', gameProbeZip, 'GAME');
const webglSession = await createUploadSession('webgl.zip', webglZip, 'WEBGL');
assertDirectMultipartSession(gameSession, 'GAME');
assertDirectMultipartSession(webglSession, 'WEBGL');

const { body: activeSessions } = await fetchJson(
	`${apiBase}/api/admin/projects/${projectId}/game-upload-sessions`,
	{ headers: { Cookie: cookie, Origin: origin } },
);
const activeKinds = new Set(activeSessions?.data?.items?.map((item) => item.uploadKind));
if (!activeKinds.has('GAME') || !activeKinds.has('WEBGL')) {
  throw new Error('GAME and WEBGL sessions did not coexist for one project');
}
console.log('ok: GAME and WEBGL upload sessions coexist independently');

const missingPartComplete = await completeDirectSession(gameSession, {
  generation: gameSession.generation,
  parts: [{ partNumber: 1, etag: '"not-uploaded"', sizeBytes: gameProbeZip.length }],
});
if (missingPartComplete.response.status !== 409 || missingPartComplete.body?.error?.code !== 'CONFLICT') {
  throw new Error(
    `missing-part direct completion returned ${missingPartComplete.response.status} (${JSON.stringify(missingPartComplete.body)})`,
  );
}
console.log('ok: direct completion rejects a manifest whose Garage parts are missing');

await fetchJson(`${apiBase}/api/admin/game-upload-sessions/${gameSession.sessionId}`, {
  method: 'DELETE',
  headers: { Cookie: cookie, Origin: origin },
});

const webglManifest = await uploadDirectMultipart(webglSession, webglZip);
const concurrentCompletions = await Promise.all([
  completeDirectSession(webglSession, webglManifest),
  completeDirectSession(webglSession, webglManifest),
]);
const completionStatuses = concurrentCompletions
  .map(({ response }) => response.status)
  .sort((a, b) => a - b);
const acceptedCompletions = concurrentCompletions.filter(({ response, body }) => (
  (response.status === 202 && body?.data?.status === 'VERIFYING')
  || (response.status === 200 && body?.data?.status === 'COMPLETED')
));
const rejectedCompletions = concurrentCompletions.filter(({ response, body }) => (
  response.status === 409
  && ['OPERATION_IN_PROGRESS', 'CONFLICT'].includes(body?.error?.code)
));
if (acceptedCompletions.length < 1
  || acceptedCompletions.length + rejectedCompletions.length !== concurrentCompletions.length) {
  throw new Error(
    `concurrent direct completion returned unsupported results: ${completionStatuses.join(', ')} ${JSON.stringify(concurrentCompletions.map(({ body }) => body))}`,
  );
}
console.log('ok: concurrent direct completion is fenced or idempotent');
const webglComplete = await waitForDirectCompletion(webglSession, webglManifest);
const webglUrl = webglComplete?.webglUrl;
if (typeof webglUrl !== 'string') throw new Error('WebGL completion did not return webglUrl');
const hostedWebglUrl = integrationApiUrl(webglUrl);

const hostedIndex = await fetch(hostedWebglUrl, { headers: { Origin: 'null' } });
const hostedIndexBody = Buffer.from(await hostedIndex.arrayBuffer());
if (
  hostedIndex.status !== 200
  || hostedIndexBody.byteLength === 0
  || !hostedIndexBody.toString('utf8').includes(webglIndexMarker)
) {
  throw new Error(`anonymous WebGL index returned ${hostedIndex.status}`);
}
const webglEtag = hostedIndex.headers.get('etag');
const webglLastModified = hostedIndex.headers.get('last-modified');
const webglCacheControl = hostedIndex.headers.get('cache-control');
const hostedIndexLength = Number(hostedIndex.headers.get('content-length'));
if (!webglEtag || !webglLastModified || !webglCacheControl) {
  throw new Error('WebGL index GET did not expose ETag, Last-Modified, and Cache-Control');
}
if (!Number.isSafeInteger(hostedIndexLength) || hostedIndexLength !== hostedIndexBody.byteLength) {
  throw new Error(
    `WebGL index GET returned inconsistent Content-Length (${hostedIndexLength}/${hostedIndexBody.byteLength})`,
  );
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

const webglEtagConditional = await fetch(hostedWebglUrl, {
  headers: { Origin: 'null', 'If-None-Match': webglEtag },
});
if (
  webglEtagConditional.status !== 304
  || (await webglEtagConditional.arrayBuffer()).byteLength !== 0
) {
  throw new Error(`WebGL If-None-Match returned ${webglEtagConditional.status} with a body`);
}
if (
  webglEtagConditional.headers.get('etag') !== webglEtag
  || webglEtagConditional.headers.get('cache-control') !== webglCacheControl
) {
  throw new Error('WebGL If-None-Match 304 did not preserve validators and cache policy');
}

const webglModifiedConditional = await fetch(hostedWebglUrl, {
  headers: { Origin: 'null', 'If-Modified-Since': webglLastModified },
});
if (
  webglModifiedConditional.status !== 304
  || (await webglModifiedConditional.arrayBuffer()).byteLength !== 0
) {
  throw new Error(`WebGL If-Modified-Since returned ${webglModifiedConditional.status} with a body`);
}

const indexRangeEnd = Math.min(7, hostedIndexBody.byteLength - 1);
const expectedIndexRange = hostedIndexBody.subarray(0, indexRangeEnd + 1);
const hostedIndexRange = await fetch(hostedWebglUrl, {
  headers: { Origin: 'null', Range: `bytes=0-${indexRangeEnd}` },
});
const hostedIndexRangeBody = Buffer.from(await hostedIndexRange.arrayBuffer());
if (
  hostedIndexRange.status !== 206
  || hostedIndexRange.headers.get('content-range') !== (
    `bytes 0-${indexRangeEnd}/${hostedIndexBody.byteLength}`
  )
  || hostedIndexRange.headers.get('content-length') !== String(expectedIndexRange.byteLength)
  || !hostedIndexRangeBody.equals(expectedIndexRange)
) {
  throw new Error(`WebGL index range returned invalid metadata or body (${hostedIndexRange.status})`);
}

const hostedIndexUnsatisfiable = await fetch(hostedWebglUrl, {
  headers: { Origin: 'null', Range: `bytes=${hostedIndexBody.byteLength}-` },
});
if (
  hostedIndexUnsatisfiable.status !== 416
  || hostedIndexUnsatisfiable.headers.get('content-range') !== (
    `bytes */${hostedIndexBody.byteLength}`
  )
  || (await hostedIndexUnsatisfiable.arrayBuffer()).byteLength !== 0
) {
  throw new Error(
    `WebGL unsatisfiable range returned invalid metadata or body (${hostedIndexUnsatisfiable.status})`,
  );
}

const hostedIndexIfRangeMatch = await fetch(hostedWebglUrl, {
  headers: {
    Origin: 'null',
    Range: `bytes=0-${indexRangeEnd}`,
    'If-Range': webglEtag,
  },
});
if (
  hostedIndexIfRangeMatch.status !== 206
  || !Buffer.from(await hostedIndexIfRangeMatch.arrayBuffer()).equals(expectedIndexRange)
) {
  throw new Error(`WebGL matching If-Range returned ${hostedIndexIfRangeMatch.status}`);
}

const hostedIndexIfRangeMiss = await fetch(hostedWebglUrl, {
  headers: {
    Origin: 'null',
    Range: `bytes=0-${indexRangeEnd}`,
    'If-Range': '"integration-mismatch"',
  },
});
if (
  hostedIndexIfRangeMiss.status !== 200
  || hostedIndexIfRangeMiss.headers.has('content-range')
  || !Buffer.from(await hostedIndexIfRangeMiss.arrayBuffer()).equals(hostedIndexBody)
) {
  throw new Error(`WebGL mismatching If-Range returned ${hostedIndexIfRangeMiss.status}`);
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
console.log(
  'ok: WebGL ZIP streams with CSP/CORS/validators/Range/If-Range/416/encoding',
);

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
