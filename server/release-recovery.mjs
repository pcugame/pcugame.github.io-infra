import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const names = ['gp-api', 'gp-worker-game-validation', 'gp-worker-webgl', 'gp-worker-video', 'gp-worker-image', 'gp-worker-export', 'gp-worker-project-publication'];
export function recoveryDecision(state, attempted, webVerified) {
 if (!state) return 'nothing';
 if (attempted) throw new Error('Migration was attempted: automatic previous-runtime recovery is forbidden; inspect DB history and forward-fix.');
 if (!webVerified) throw new Error('Previous Pages content has not been verified; refusing mixed web/API recovery.');
 if (!state.containers?.some(c => c.name === 'gp-api')) throw new Error('Missing captured API');
 for (const c of state.containers) {
  if (!names.includes(c.name) || !/^[a-f0-9]{64}$/.test(c.id)) throw new Error('Invalid captured container');
 }
 return 'restart';
}
function save(file, content) {
 writeFileSync(file, content, { mode: 0o600, flag: 'wx' });
 const fd = openSync(file, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
export async function runRecovery(mode, key, { deployDir = process.env.DEPLOY_DIR || '/srv/graduationproject_v2', webVerified = process.env.WEB_RECOVERY_VERIFIED === 'true', podman = args => execFileSync('podman', args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
 if (!/^\d+-\d+$/.test(key ?? '')) throw new Error('Invalid release run key');
 const dir = join(deployDir, 'cutover-state', `recovery-${key}`);
 const stateFile = join(dir, 'runtime.json');
 const attemptFile = join(dir, 'migration-attempted');
 const inspect = name => JSON.parse(podman(['inspect', name]))[0];
 if (mode === 'capture') {
  mkdirSync(dir, { mode: 0o700 });
  const containers = [];
  for (const name of names) {
   let current;
   try { current = inspect(name); } catch (error) { if (name === 'gp-api') throw error; else continue; }
   if (current.State.Status === 'running') containers.push({ name, id: current.Id, image: current.Image });
  }
  recoveryDecision({ containers }, false, true);
  save(stateFile, JSON.stringify({ containers }));
  console.log(`recovery_capture=${containers.length}`);
  return;
 }
 if (mode === 'mark-migration') {
  if (!existsSync(stateFile)) throw new Error('Runtime recovery capture is missing');
  save(attemptFile, `${new Date().toISOString()}\n`);
  const fd = openSync(dir, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  return;
 }
 if (mode !== 'recover') throw new Error('Expected capture, mark-migration or recover');
 const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
 if (recoveryDecision(state, existsSync(attemptFile), webVerified) === 'nothing') { console.log('recovery_not_needed=true'); return; }
 for (const c of state.containers) {
  const current = inspect(c.name);
  if (current.Id !== c.id || current.Image !== c.image) throw new Error(`Container changed since capture: ${c.name}`);
 }
 for (const c of state.containers) if (inspect(c.id).State.Status !== 'running') podman(['start', c.id]);
 let healthy = false;
 for (let i = 0; i < 30; i++) {
  try { healthy = JSON.parse(podman(['exec', 'gp-api', 'wget', '-qO-', 'http://localhost:4000/api/health'])).ok === true; } catch { /* bounded startup wait */ }
  if (healthy) break;
  await sleep(1000);
 }
 if (!healthy || state.containers.some(c => inspect(c.id).State.Status !== 'running')) throw new Error('Previous runtime recovery health failed');
 const drained = join(deployDir, 'cutover-state', 'mutation-drained');
 if (existsSync(drained)) unlinkSync(drained);
 save(join(dir, 'recovered'), `${new Date().toISOString()}\n`);
 console.log('previous_runtime_recovered=true');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 runRecovery(process.argv[2], process.argv[3]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
