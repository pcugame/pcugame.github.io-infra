// An already authorized public transform URL; no mutations or credentials logged.
import assert from 'node:assert/strict';
const url = new URL(process.argv[2] ?? process.env.IMAGE_SMOKE_URL);
assert.match(url.pathname, /^\/img\/v1\/(320|480|768|960|1440|1920)\/[A-Za-z0-9_-]+$/);
assert.equal(url.search, '');
for (let attempt = 0; attempt < 2; attempt++) {
 const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
 assert.equal(response.status, 200, 'image conversion must succeed');
 assert.match(response.headers.get('content-type') ?? '', /^image\/webp/);
 assert.equal(response.headers.get('cache-control'), 'private, no-store');
 const bytes = new Uint8Array(await response.arrayBuffer());
 assert.ok(bytes.length > 12);
 assert.equal(new TextDecoder().decode(bytes.subarray(8, 12)), 'WEBP');
 if (attempt === 1) assert.equal(response.headers.get('x-image-cache'), 'HIT');
}
console.log('Image conversion and authorized warm cache passed');
