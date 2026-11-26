import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, unlinkSync } from 'node:fs';
import { join, isAbsolute, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const names = ['gp-api', 'gp-worker-game-validation', 'gp-worker-webgl', 'gp-worker-video', 'gp-worker-image', 'gp-worker-export', 'gp-worker-project-publication'];
const units = [...names.map(name => `${name}.service`), 'graduationproject-pod.service', 'gp-postgres.service', 'gp-pg-data-volume.service'];
const sourceFiles = [...names.map(name => `${name}.container`), 'gp-postgres.container', 'graduationproject.pod', 'gp-pg-data.volume'];
const immutable = /^\S+@sha256:[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
export function recoveryDecision(state, attempted, webVerified) {
 if (attempted) throw new Error('Migration was attempted: automatic previous-runtime recovery is forbidden; inspect DB history and forward-fix.');
 if (!state) return 'nothing';
 if (!webVerified) throw new Error('Previous Pages content has not been verified; refusing mixed web/API recovery.');
 if (!state.containers?.some(c => c.name === 'gp-api')) throw new Error('Missing captured API');
 if (state.version !== 2 || !state.definitionHash || !state.quadletDir) throw new Error('Invalid captured runtime definitions');
 const seen = new Set();
 for (const c of state.containers) {
  if (!names.includes(c.name) || seen.has(c.name) || !immutable.test(c.imageName) || !/^(sha256:)?[a-f0-9]{64}$/.test(c.image)) throw new Error('Invalid captured container');
  seen.add(c.name);
 }
 return 'restart';
}
function migrationAttempted(file) {
 try { lstatSync(file); return true; }
 catch (error) {
  // Only confirmed absence permits recovery; unreadable state fails closed.
  if (error.code === 'ENOENT') return false;
  throw error;
 }
}
function save(file, content) {
 writeFileSync(file, content, { mode: 0o600, flag: 'wx' });
 const fd = openSync(file, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
// Hash definitions and environment contents; recovery state must never contain secrets.
function definitions(quadletDir, systemctl) {
 const entries = [], environmentFiles = new Set();
 function collectEnvironment(content, source) {
  for (const match of content.matchAll(/^EnvironmentFile=(.+)$/gm)) {
   let path = match[1].trim().replace(/^-/, '');
   if (path.startsWith('"')) {
    // The renderer quotes paths and escapes quote/backslash; reject unsupported syntax.
    try { path = JSON.parse(path); } catch { throw new Error(`Unsupported recovery environment path in ${source}`); }
   }
   if (!isAbsolute(path) || /%/.test(path.replace(/%%/g, ''))) throw new Error(`Unsupported recovery environment path in ${source}`);
   environmentFiles.add(path.replace(/%%/g, '%').replace(/\$\$/g, '$'));
  }
 }
 for (const name of sourceFiles) {
  const file = join(quadletDir, name), content = readFileSync(file);
  entries.push([file, hash(content)]);
  collectEnvironment(content.toString(), file);
 }
 for (const unit of units) {
  const content = systemctl(['--user', 'cat', unit]);
  entries.push([unit, hash(content)]);
  // Command definitions come from cat; do not fingerprint volatile Exec runtime metadata.
  const effective = systemctl(['--user', 'show', unit, '--property=LoadState,NeedDaemonReload,FragmentPath,SourcePath,DropInPaths,Environment,EnvironmentFiles,Requires,Wants,After,Before,PartOf,BindsTo,Restart']);
  if (!/^LoadState=loaded$/m.test(effective)) throw new Error(`Recovery unit is not loaded: ${unit}`);
  if (!/^NeedDaemonReload=no$/m.test(effective)) throw new Error(`Recovery unit requires daemon reload: ${unit}`);
  entries.push([`${unit}:effective`, hash(effective)]);
  collectEnvironment(content, unit);
 }
 for (const file of [...environmentFiles].sort()) entries.push([file, hash(readFileSync(file))]);
 return hash(JSON.stringify(entries));
}
export async function runRecovery(mode, key, {
 deployDir = process.env.DEPLOY_DIR || '/srv/graduationproject_v2',
 quadletDir = process.env.QUADLET_DIR,
 webVerified = process.env.WEB_RECOVERY_VERIFIED === 'true',
 podman = args => execFileSync('podman', args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }),
 systemctl = args => execFileSync('systemctl', args, { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }),
 sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
 if (!/^\d+-\d+$/.test(key ?? '')) throw new Error('Invalid release run key');
 const dir = join(deployDir, 'cutover-state', `recovery-${key}`);
 const stateFile = join(dir, 'runtime.json');
 const attemptFile = join(dir, 'migration-attempted');
 const resolveQuadletDir = () => {
  if (quadletDir) return quadletDir;
  // The workflow runs this tool separately from deploy.sh's shell .env loader.
  // Discover the adopted source, including a host-specific QUADLET_DIR.
  const source = systemctl(['--user', 'show', 'gp-api.service', '--property=SourcePath', '--value']).trim();
  const fragment = systemctl(['--user', 'show', 'gp-api.service', '--property=FragmentPath', '--value']).trim();
  if (!isAbsolute(source) || basename(source) !== 'gp-api.container' || !/\/generator[^/]*\/gp-api\.service$/.test(fragment)) throw new Error('Recovery requires an adopted Quadlet API service');
  return dirname(source);
 };
 const inspect = name => {
  try { return JSON.parse(podman(['inspect', name]))[0]; }
  catch (error) { if (/no such|not found|does not exist/i.test(`${error.message} ${error.stderr || ''}`)) return null; throw error; }
 };
 const active = name => systemctl(['--user', 'show', `${name}.service`, '--property=ActiveState,SubState']).trim();
 const verify = c => {
  const current = inspect(c.name), unitState = active(c.name);
  if (!current || current.Name?.replace(/^\//, '') !== c.name || current.Image !== c.image || current.ImageName !== c.imageName || current.State.Status !== 'running' || !/^ActiveState=active$/m.test(unitState) || !/^SubState=running$/m.test(unitState)) throw new Error(`Previous runtime recovery identity/state failed: ${c.name}`);
 };
 if (mode === 'capture') {
  quadletDir = resolveQuadletDir();
  mkdirSync(dir, { mode: 0o700 });
  const containers = [];
  for (const name of names) {
   const current = inspect(name);
   if (current?.State.Status === 'running') {
    const imageName = current.ImageName;
    const imageLines = readFileSync(join(quadletDir, `${name}.container`), 'utf8').match(/^Image=(.+)$/gm) || [];
    if (imageLines.length !== 1 || imageLines[0] !== `Image=${imageName}`) throw new Error(`Quadlet image differs from running container: ${name}`);
    const c = { name, image: current.Image, imageName };
    verify(c);
    containers.push(c);
   }
  }
  const state = { version: 2, quadletDir, containers, definitionHash: definitions(quadletDir, systemctl) };
  recoveryDecision(state, false, true);
  save(stateFile, JSON.stringify(state));
  console.log(`recovery_capture=${containers.length}`);
  return;
 }
 if (mode === 'mark-migration') {
  if (!existsSync(stateFile)) throw new Error('Runtime recovery capture is missing');
  save(attemptFile, `${new Date().toISOString()}\n`);
  const fd = openSync(dir, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  return;
 }
 if (mode === 'assert-pre-migration') {
  if (migrationAttempted(attemptFile)) recoveryDecision(null, true, false);
  // A completed capture is required before authorizing Pages recovery.
  JSON.parse(readFileSync(stateFile, 'utf8'));
  console.log('pre_migration_recovery_allowed=true');
  return;
 }
 if (mode !== 'recover') throw new Error('Expected capture, mark-migration, assert-pre-migration or recover');
 const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
 if (recoveryDecision(state, migrationAttempted(attemptFile), webVerified) === 'nothing') { console.log('recovery_not_needed=true'); return; }
 quadletDir = resolveQuadletDir();
 if (state.quadletDir !== quadletDir || state.definitionHash !== definitions(quadletDir, systemctl)) throw new Error('Runtime definitions changed since capture; refusing recovery');
 for (const c of state.containers) {
  const current = inspect(c.name);
  if (current && (current.Name?.replace(/^\//, '') !== c.name || current.Image !== c.image || current.ImageName !== c.imageName)) throw new Error(`Container image changed since capture: ${c.name}`);
 }
 systemctl(['--user', 'start', 'gp-api.service']);
 verify(state.containers.find(c => c.name === 'gp-api'));
 let healthy = false;
 for (let i = 0; i < 30; i++) {
  try { healthy = JSON.parse(podman(['exec', 'gp-api', 'wget', '-qO-', 'http://localhost:4000/api/health'])).ok === true; } catch { /* bounded startup wait */ }
  if (healthy) break;
  await sleep(1000);
 }
 if (!healthy) throw new Error('Previous runtime recovery health failed');
 for (const c of state.containers) if (c.name !== 'gp-api') systemctl(['--user', 'start', `${c.name}.service`]);
 for (const c of state.containers) verify(c);
 const drained = join(deployDir, 'cutover-state', 'mutation-drained');
 if (existsSync(drained)) unlinkSync(drained);
 save(join(dir, 'recovered'), `${new Date().toISOString()}\n`);
 console.log('previous_runtime_recovered=true');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 runRecovery(process.argv[2], process.argv[3]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
