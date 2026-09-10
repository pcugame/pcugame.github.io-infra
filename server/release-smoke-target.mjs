import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function validateSmokeUrl(value, originValue) {
  const origin = new URL(originValue);
  const url = new URL(value);
  if (origin.protocol !== 'https:' || origin.origin !== originValue || url.protocol !== 'https:' || url.origin !== origin.origin || url.username || url.password || url.search || url.hash || url.pathname === '/') {
    throw new Error('Smoke target must be an unsigned HTTPS object on the running API public asset origin');
  }
  return url.href;
}
export function selectSmokeUrl({ origin, years }, override = '') {
  if (override) return validateSmokeUrl(override, origin);
  if (years?.ok !== true || !Array.isArray(years.data?.items)) throw new Error('Public years response is invalid');
  for (const item of years.data.items) {
    const original = item?.poster?.original?.url;
    if (!original) continue;
    try { return validateSmokeUrl(original, origin); } catch { /* Skip legacy API and foreign-origin images. */ }
  }
  throw new Error('No canonical public year poster is available for data-plane smoke; supply an existing public object URL');
}
export function validateStoredTarget(record, source, origin) {
  if (record?.source_sha !== source || record.origin !== origin) throw new Error('Stored smoke target does not match this source or public origin');
  return validateSmokeUrl(record.url, origin);
}
const publicOriginScript = 'process.stdout.write(process.env.PUBLIC_ASSET_ORIGIN || "")';
async function main() {
  const [mode, source] = process.argv.slice(2);
  if (!['prepare', 'read'].includes(mode) || !/^[a-f0-9]{40}$/.test(source ?? '')) throw new Error('usage: release-smoke-target.mjs prepare|read <source-sha>');
  const directory = join(process.env.DEPLOY_DIR || '/srv/graduationproject_v2', 'cutover-state');
  const path = join(directory, `smoke-target-${source}.json`);
  const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024, ...options });
  const origin = run('podman', ['exec', 'gp-api', 'node', '-e', publicOriginScript]);
  if (mode === 'read') {
    process.stdout.write(validateStoredTarget(JSON.parse(readFileSync(path, 'utf8')), source, origin));
    return;
  }
  const override = process.env.SMOKE_PUBLIC_OBJECT_URL || '';
  const years = override ? null : JSON.parse(run('podman', ['exec', 'gp-api', 'node', '-e', 'fetch("http://localhost:4000/api/public/years", {redirect:"error", signal:AbortSignal.timeout(15000)}).then(async r => { if(!r.ok) throw new Error("Public years HTTP " + r.status); process.stdout.write(await r.text()); }).catch(e => { console.error(e.message); process.exit(1); })']));
  const url = selectSmokeUrl({ origin, years }, override);
  // Exercise the same public data-plane boundary before any process is drained.
  run(process.execPath, [fileURLToPath(new URL('./smoke-data-plane.mjs', import.meta.url)), url], { stdio: 'inherit' });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ source_sha: source, origin, url, verified_at: new Date().toISOString() })}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
  console.log(`Verified public smoke target saved for source ${source}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
