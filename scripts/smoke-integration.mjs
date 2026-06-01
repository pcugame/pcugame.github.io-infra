const apiBase = process.env.INTEGRATION_API_BASE_URL || 'http://localhost:4000';
const webBase = process.env.INTEGRATION_WEB_BASE_URL || 'http://localhost:5173';
const origin = process.env.INTEGRATION_ORIGIN || webBase;

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
  headers: { Cookie: cookie },
});
if (!me?.data?.authenticated || me.data.user.role !== 'ADMIN') {
  throw new Error('/api/me did not resolve the dev-auth session');
}
console.log('ok: session cookie resolves through /api/me');

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

console.log('integration smoke passed');
