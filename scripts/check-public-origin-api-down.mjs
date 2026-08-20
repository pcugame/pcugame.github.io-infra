import { createHash } from 'node:crypto';
import { request } from 'node:http';

const apiHealthUrl = process.env.INTEGRATION_API_HEALTH_URL || 'http://127.0.0.1:4000/api/health';
const publicProxyUrl = process.env.INTEGRATION_PUBLIC_ASSET_URL
  || 'http://127.0.0.1:3904/integration-poster.png?api=stopped';
const garageWebsiteUrl = process.env.INTEGRATION_GARAGE_WEBSITE_URL
  || 'http://127.0.0.1:3902/integration-poster.png?api=stopped';
const publicHost = process.env.INTEGRATION_PUBLIC_ASSET_HOST
  || 'pcu-public.web.garage.localhost:3904';

function get(url, host, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { ...(host ? { Host: host } : {}), ...headers } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

let apiStopped = false;
try {
  const health = await get(apiHealthUrl);
  apiStopped = health.status < 200 || health.status >= 500;
} catch {
  apiStopped = true;
}
if (!apiStopped) throw new Error('API is still reachable during the API-down public-origin check');

const [proxied, direct] = await Promise.all([
  get(publicProxyUrl, publicHost),
  get(garageWebsiteUrl, publicHost),
]);
if (proxied.status !== 200 || direct.status !== 200 || proxied.body.length === 0) {
  throw new Error(`public object unavailable with API down (proxy=${proxied.status}, Garage=${direct.status})`);
}
const digest = (body) => createHash('sha256').update(body).digest('hex');
if (digest(proxied.body) !== digest(direct.body)) {
  throw new Error('ordinary public reverse proxy changed the Garage object bytes');
}
if (!proxied.headers.etag || proxied.headers.etag !== direct.headers.etag) {
  throw new Error('ordinary public reverse proxy did not preserve the Garage ETag');
}
const conditional = await get(publicProxyUrl, publicHost, {
  'If-None-Match': proxied.headers.etag,
});
if (conditional.status !== 304 || conditional.body.length !== 0) {
  throw new Error(`public proxy validator response was not a bodyless 304 (${conditional.status})`);
}
if (conditional.headers.etag !== proxied.headers.etag || !conditional.headers['last-modified']) {
  throw new Error('public proxy 304 omitted ETag or Last-Modified validators');
}

console.log(JSON.stringify({
  action: 'public_origin_health',
  result: 'healthy',
  status: proxied.status,
}));
