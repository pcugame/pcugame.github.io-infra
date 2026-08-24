import assert from 'node:assert/strict';

const [url] = process.argv.slice(2);
if (!url || (!url.startsWith('https://') && !(process.env.ALLOW_INSECURE_SMOKE === 'true' && url.startsWith('http://')))) {
  throw new Error('usage: smoke-data-plane.mjs https://public-origin/immutable-object');
}

const full = await fetch(url, { redirect: 'error' });
assert.equal(full.status, 200, 'public object GET');
const body = Buffer.from(await full.arrayBuffer());
assert.ok(body.length > 0, 'public object body');
assert.ok(full.headers.get('content-type'), 'Content-Type');
assert.ok(full.headers.get('etag'), 'ETag');
assert.ok(full.headers.get('last-modified'), 'Last-Modified');

const head = await fetch(url, { method: 'HEAD', redirect: 'error' });
assert.equal(head.status, 200, 'public object HEAD');
assert.equal((await head.arrayBuffer()).byteLength, 0, 'HEAD body');
assert.equal(Number(head.headers.get('content-length')), body.length, 'HEAD Content-Length');

const conditional = await fetch(url, { headers: { 'If-None-Match': full.headers.get('etag') }, redirect: 'error' });
assert.equal(conditional.status, 304, 'public object 304');
assert.equal((await conditional.arrayBuffer()).byteLength, 0, '304 body');

const end = Math.min(7, body.length - 1);
const partial = await fetch(url, { headers: { Range: `bytes=0-${end}` }, redirect: 'error' });
assert.equal(partial.status, 206, 'public object range');
assert.equal(partial.headers.get('content-range'), `bytes 0-${end}/${body.length}`, 'Content-Range');
assert.deepEqual(Buffer.from(await partial.arrayBuffer()), body.subarray(0, end + 1), 'range body');

const unsatisfiable = await fetch(url, { headers: { Range: `bytes=${body.length}-` }, redirect: 'error' });
assert.equal(unsatisfiable.status, 416, 'public object 416');
assert.equal(unsatisfiable.headers.get('content-range'), `bytes */${body.length}`, '416 Content-Range');
assert.equal(unsatisfiable.headers.get('cache-control'), 'no-store', '416 cache policy');
await unsatisfiable.arrayBuffer();

console.log(JSON.stringify({ event: 'public_data_plane_smoke_passed', url, size: body.length }));
