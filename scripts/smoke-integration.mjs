import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { brotliCompressSync, gzipSync } from 'node:zlib';

const apiBase = process.env.INTEGRATION_API_BASE_URL || 'http://localhost:4000';
const webBase = process.env.INTEGRATION_WEB_BASE_URL || 'http://localhost:5173';
const origin = process.env.INTEGRATION_ORIGIN || webBase;
const internalPublicAssetBase = process.env.INTEGRATION_PUBLIC_ASSET_BASE_URL
  ? new URL(process.env.INTEGRATION_PUBLIC_ASSET_BASE_URL)
  : null;
const internalUploadPartBase = process.env.INTEGRATION_UPLOAD_PART_BASE_URL
  ? new URL(process.env.INTEGRATION_UPLOAD_PART_BASE_URL)
  : null;
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

function integrationPublicAssetUrl(url) {
  if (!internalPublicAssetBase) return url;
  const target = new URL(url);
  target.protocol = internalPublicAssetBase.protocol;
  target.host = internalPublicAssetBase.host;
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

const { body: publicProject } = await fetchJson(
  `${apiBase}/api/public/projects/integration-public-asset`,
);
const publicImageUrl = publicProject?.data?.poster?.original?.url;
if (typeof publicImageUrl !== 'string' || new URL(publicImageUrl).origin === new URL(apiBase).origin) {
  throw new Error('integration poster did not expose a direct public-origin URL');
}
const publicImageFetchUrl = integrationPublicAssetUrl(publicImageUrl);
const assetRes = await fetch(publicImageFetchUrl, { redirect: 'manual' });
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

const assetHead = await fetch(publicImageFetchUrl, { method: 'HEAD' });
if (assetHead.status !== 200 || !assetHead.headers.get('content-length')) {
  throw new Error(`public image HEAD returned invalid metadata (${assetHead.status})`);
}
const imageEtag = assetHead.headers.get('etag');
if (imageEtag) {
  const conditional = await fetch(publicImageFetchUrl, {
    headers: { 'If-None-Match': imageEtag },
  });
  if (conditional.status !== 304 || (await conditional.arrayBuffer()).byteLength !== 0) {
    throw new Error('public image conditional request did not return a bodyless 304');
  }
}
console.log('ok: public image direct origin, HEAD, and immutable cache');
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
  ['UnityBuild/Build/integration.loader.js', 'globalThis.createUnityInstance = globalThis.createUnityInstance || (() => {});'],
  ['UnityBuild/Build/integration.framework.js', 'globalThis.integrationFramework = true;'],
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
  const blockSize = 1_048_576;
  const digests = [];
  for (let offset = 0; offset < body.length; offset += blockSize) {
    digests.push(createHash('sha256').update(body.subarray(offset, offset + blockSize)).digest());
  }
  const header = Buffer.alloc(16);
  header.writeBigUInt64BE(BigInt(body.length), 0);
  header.writeUInt32BE(blockSize, 8);
  header.writeUInt32BE(digests.length, 12);
  const sourceIdentity = createHash('sha256')
    .update(Buffer.from('PCU-UPLOAD-SOURCE-V1\0'))
    .update(header)
    .update(Buffer.concat(digests))
    .digest('hex');
  const { body: response } = await fetchJson(
    `${apiBase}/api/admin/projects/${projectId}/direct-${uploadKind.toLowerCase()}-upload-sessions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: origin,
      },
      body: JSON.stringify({
        originalName,
        totalBytes: body.length,
        declaredMimeType: 'application/zip',
        sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1',
        sourceIdentity,
        sourceIdentityBlockSizeBytes: blockSize,
        sourceIdentityBlockDigests: digests.map((digest) => digest.toString('hex')),
      }),
    },
  );
  return response?.data;
}

const gameSession = await createUploadSession('game-probe.zip', gameProbeZip, 'GAME');
const webglSession = await createUploadSession('webgl.zip', webglZip, 'WEBGL');
if (gameSession?.owner?.id !== projectId || webglSession?.owner?.id !== projectId) {
  throw new Error('direct upload sessions did not preserve canonical owner identity');
}
console.log('ok: GAME and WEBGL upload sessions coexist independently');

const missingChunkComplete = await fetch(
  `${apiBase}/api/admin/direct-asset-upload-sessions/${gameSession.sessionId}/complete`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin },
    body: JSON.stringify({ generation: gameSession.generation, parts: [] }),
  },
);
if (missingChunkComplete.status !== 400) {
  throw new Error(`missing-chunk completion returned ${missingChunkComplete.status}`);
}
const missingChunkBody = await missingChunkComplete.json();
if (missingChunkBody?.error?.code !== 'ERROR') {
  throw new Error('missing-chunk completion did not preserve the existing ERROR envelope');
}
console.log('ok: direct completion rejects a missing Garage part manifest');

async function putDirectPart(capability, body) {
  const target = new URL(capability.url);
  const signedHost = target.host;
  if (internalUploadPartBase) {
    target.protocol = internalUploadPartBase.protocol;
    target.host = internalUploadPartBase.host;
  }
  return new Promise((resolve, reject) => {
    const request = httpRequest(target, {
      method: 'PUT',
      headers: { ...capability.requiredHeaders, Host: signedHost, 'Content-Length': String(body.length) },
    }, (response) => {
      const etag = response.headers.etag;
      response.resume();
      response.once('end', () => {
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300 || !etag) {
          reject(new Error(`direct UploadPart returned ${response.statusCode} without ETag`));
        } else resolve(etag);
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function uploadAndComplete(session, body) {
  const parts = [];
  for (let partNumber = 1; partNumber <= session.totalParts; partNumber += 1) {
    const start = (partNumber - 1) * session.partSizeBytes;
    const part = body.subarray(start, Math.min(start + session.partSizeBytes, body.length));
    const checksumSha256 = createHash('sha256').update(part).digest('base64');
    const { body: signed } = await fetchJson(
      `${apiBase}/api/admin/direct-asset-upload-sessions/${session.sessionId}/part-urls`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin },
        body: JSON.stringify({ generation: session.generation, parts: [{ partNumber, checksumSha256 }] }),
      },
    );
    const capability = signed?.data?.parts?.[0];
    if (!capability) throw new Error('part capability was not issued');
    const etag = await putDirectPart(capability, part);
    parts.push({ partNumber, etag, sizeBytes: part.length });
  }
  const { body: completed } = await fetchJson(
    `${apiBase}/api/admin/direct-asset-upload-sessions/${session.sessionId}/complete`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin },
      body: JSON.stringify({ generation: session.generation, parts }),
    },
  );
  if (completed?.data?.status !== 'VERIFYING') throw new Error('direct completion did not enter VERIFYING');
  await waitFor(`direct ${session.sessionId} worker readiness`, async () => {
    const { body: status } = await fetchJson(
      `${apiBase}/api/admin/direct-asset-upload-sessions/${session.sessionId}`,
      { headers: { Cookie: cookie, Origin: origin } },
    );
    if (status?.data?.state !== 'READY') throw new Error(`state=${status?.data?.state}`);
  });
}

await uploadAndComplete(gameSession, gameProbeZip);
await uploadAndComplete(webglSession, webglZip);
console.log('ok: browser bytes use presigned Garage UploadPart capabilities, not API relay');

const { body: projectAfterWebgl } = await fetchJson(
  `${apiBase}/api/public/projects/integration-public-asset`,
);
const webglUrl = projectAfterWebgl?.data?.webglUrl;
if (typeof webglUrl !== 'string' || new URL(webglUrl).origin === new URL(apiBase).origin) {
  throw new Error('WebGL worker did not publish an immutable public-origin deployment URL');
}
const hostedWebglUrl = integrationPublicAssetUrl(webglUrl);

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
if (hostedIndex.headers.get('access-control-allow-origin') !== 'null') {
	throw new Error('WebGL index did not echo the configured credential-free null origin');
}
if (hostedIndex.headers.has('access-control-allow-credentials')) {
	throw new Error('WebGL index unexpectedly allowed credentials');
}
if (!hostedIndex.headers.get('vary')?.split(',').map((value) => value.trim().toLowerCase()).includes('origin')) {
	throw new Error('WebGL index did not vary credential-free CORS by Origin');
}
if (hostedIndex.headers.has('x-frame-options')) {
  throw new Error('WebGL index retained the global iframe denial header');
}
const webglCsp = hostedIndex.headers.get('content-security-policy') || '';
if (!webglCsp.includes(`frame-ancestors ${new URL(origin).origin}`)) {
  throw new Error(`WebGL index returned an unexpected CSP: ${webglCsp}`);
}
if (!webglCsp.includes("connect-src 'self' blob:") || new URL(webglUrl).origin === new URL(apiBase).origin) {
  throw new Error(`WebGL index did not isolate immutable public-origin asset connections: ${webglCsp}`);
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
// Garage v1.1.0's website endpoint omits ETag/Last-Modified on a valid 304.
// The original 200/HEAD validators are asserted above; the proxy must preserve
// the bodyless 304 while ensuring that revalidation responses are never cached
// as a new immutable representation.
if (webglEtagConditional.headers.get('cache-control') !== 'no-store') {
  throw new Error('WebGL If-None-Match 304 was cached as immutable');
}

const webglModifiedConditional = await fetch(hostedWebglUrl, {
  headers: { Origin: 'null', 'If-Modified-Since': webglLastModified },
});
const webglModifiedBody = Buffer.from(await webglModifiedConditional.arrayBuffer());
if (webglModifiedConditional.status === 304) {
  if (webglModifiedBody.byteLength !== 0 || webglModifiedConditional.headers.get('cache-control') !== 'no-store') {
    throw new Error('WebGL If-Modified-Since 304 returned a body or was cached as immutable');
  }
} else if (
  webglModifiedConditional.status !== 200
  || !webglModifiedBody.equals(hostedIndexBody)
  || webglModifiedConditional.headers.get('etag') !== webglEtag
  || webglModifiedConditional.headers.get('last-modified') !== webglLastModified
) {
  // Garage v1.1.0 may ignore If-Modified-Since. A complete, validator-bearing
  // 200 is a safe (though less efficient) conditional-request fallback.
  throw new Error(`WebGL If-Modified-Since returned an invalid fallback (${webglModifiedConditional.status})`);
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
  || hostedIndexUnsatisfiable.headers.get('cache-control') !== 'no-store'
) {
  throw new Error(
    `WebGL unsatisfiable range returned invalid metadata or body (${hostedIndexUnsatisfiable.status})`,
  );
}
await hostedIndexUnsatisfiable.arrayBuffer();

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
const hostedIndexIfRangeMissBody = Buffer.from(await hostedIndexIfRangeMiss.arrayBuffer());
const validIfRangeFullFallback = hostedIndexIfRangeMiss.status === 200
  && !hostedIndexIfRangeMiss.headers.has('content-range')
  && hostedIndexIfRangeMissBody.equals(hostedIndexBody);
const validImmutableRangeFallback = hostedIndexIfRangeMiss.status === 206
  && hostedIndexIfRangeMiss.headers.get('content-range') === (
    `bytes 0-${indexRangeEnd}/${hostedIndexBody.byteLength}`
  )
  && hostedIndexIfRangeMissBody.equals(expectedIndexRange);
// Garage v1.1.0's website endpoint may ignore a mismatching If-Range. These
// resources use immutable generation URLs, so accepting the exact requested
// range cannot splice bytes across object versions.
if (!validIfRangeFullFallback && !validImmutableRangeFallback) {
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
  await waitFor('deleted WebGL generation cleanup', async () => {
    const deletedWebgl = await fetch(hostedWebglUrl, { headers: { Origin: 'null' } });
    if (deletedWebgl.status !== 404 || deletedWebgl.headers.get('cache-control') !== 'no-store') {
      throw new Error(`deleted WebGL deployment remained public/cacheable with ${deletedWebgl.status}`);
    }
  });
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
