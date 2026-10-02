# shellcheck shell=bash
# Source-only module: loaded by deploy.sh in its shared release context.

do_api_smoke() {
  local api_elapsed=0 api_healthy=0
  while (( api_elapsed < HEALTHCHECK_TIMEOUT )); do
    if podman exec "$API_CONTAINER" wget -qO- http://localhost:4000/api/health 2>/dev/null | grep -q '"ok":true'; then
      api_healthy=1
      break
    fi
    sleep 2
    api_elapsed=$((api_elapsed + 2))
  done
  if (( api_healthy == 0 )); then
    echo "ERROR: API health check did not pass within ${HEALTHCHECK_TIMEOUT}s"
    podman logs "$API_CONTAINER" --tail 30 2>/dev/null || true
    return 1
  fi
}

do_verify_final_web() {
  local expected_sha="${1:-}"
  load_env
  [[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]] || {
    echo "ERROR: verify-final-web requires the exact 40-character lowercase Git commit SHA"
    return 1
  }
  EXPECTED_WEB_RELEASE_SHA="$expected_sha" WEB_RELEASE_BASE_URL="$WEB_PUBLIC_URL" node --input-type=module <<'NODE'
const expectedSha = process.env.EXPECTED_WEB_RELEASE_SHA;
const baseUrl = process.env.WEB_RELEASE_BASE_URL;
let url;
try {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('WEB_PUBLIC_URL must be an exact HTTPS origin');
  }
  url = new URL('/release-sha.txt', base);
} catch (error) {
  console.error(`ERROR: cannot construct final web release marker URL: ${error.message}`);
  process.exit(1);
}
const response = await fetch(url, {
  redirect: 'manual',
  cache: 'no-store',
  headers: {
    Accept: 'text/plain',
    'Accept-Encoding': 'identity',
    'Cache-Control': 'no-cache',
  },
  signal: AbortSignal.timeout(5000),
});
if (response.status !== 200) {
  throw new Error(`final web release marker returned HTTP ${response.status}; redirects are forbidden`);
}
const contentType = response.headers.get('content-type') ?? '';
if (!/^text\/plain(?:;\s*charset=utf-8)?$/i.test(contentType)) {
  throw new Error(`final web release marker has unexpected Content-Type ${contentType || '(missing)'}`);
}
const contentEncoding = response.headers.get('content-encoding');
if (contentEncoding !== null && contentEncoding.toLowerCase() !== 'identity') {
  throw new Error(`final web release marker ignored identity encoding: ${contentEncoding}`);
}
const expected = Buffer.from(`${expectedSha}\n`, 'utf8');
const declaredLength = response.headers.get('content-length');
if (declaredLength !== null && Number(declaredLength) !== expected.length) {
  throw new Error(`final web release marker has unexpected Content-Length ${declaredLength}`);
}
const reader = response.body?.getReader();
if (!reader) throw new Error('final web release marker has no response body');
const chunks = [];
let length = 0;
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  length += value.byteLength;
  if (length > expected.length) {
    await reader.cancel();
    throw new Error('final web release marker body is longer than the exact SHA marker');
  }
  chunks.push(Buffer.from(value));
}
const actual = Buffer.concat(chunks, length);
if (!actual.equals(expected)) {
  throw new Error('final web release marker does not exactly equal GITHUB_SHA followed by one LF');
}
console.log(`Final web release ${expectedSha} verified without redirect.`);
NODE
}

