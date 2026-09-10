import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function pagesRestoreDecision({ before, current, subject, releaseSha, source, runKey }) {
 if (![before, current, source].every(sha => /^[a-f0-9]{40}$/.test(sha)) || !/^\d+-\d+$/.test(runKey)) throw new Error('Invalid Pages recovery identity');
 if (before === current) return 'unchanged';
 if (subject !== `Deploy ${source} (run ${runKey})` || releaseSha !== source) throw new Error('Pages changed outside this release; refusing to overwrite another writer');
 return 'restore';
}
export async function runPagesRecovery(mode, directory, source, runKey, { token = process.env.PAGES_DEPLOY_TOKEN, exec = execFileSync, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
 if (!token || !/^[a-f0-9]{40}$/.test(source ?? '') || !/^\d+-\d+$/.test(runKey ?? '')) throw new Error('Missing valid Pages recovery inputs');
 const dir = resolve(directory);
 const file = join(dir, 'recovery.json');
 const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_TRACE: '0', GIT_TRACE_CURL: '0', GIT_CURL_VERBOSE: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` };
 const git = args => {
  try { return exec('git', args, { cwd: dir, env, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error(`Pages recovery git ${args[0]} failed`); }
 };
 if (mode === 'capture') {
  mkdirSync(dir, { mode: 0o700 });
  git(['init', '--bare']);
  git(['remote', 'add', 'origin', 'https://github.com/pcugame/pcugame.github.io.git']);
  git(['fetch', '--no-tags', 'origin', 'master']);
  const before = git(['rev-parse', 'FETCH_HEAD']);
  if (!/^[a-f0-9]{40}$/.test(before)) throw new Error('Invalid previous Pages commit');
  git(['update-ref', 'refs/recovery/previous', before]);
  const previousSource = git(['show', `${before}:release-sha.txt`]);
  if (!/^[a-f0-9]{40}$/.test(previousSource)) throw new Error('Previous Pages release marker is missing');
  writeFileSync(file, JSON.stringify({ before, source, runKey, previousSource }), { mode: 0o600, flag: 'wx' });
  console.log(`previous_pages_commit=${before}`);
  return;
 }
 if (mode !== 'restore') throw new Error('Expected capture or restore');
 if (!existsSync(file)) throw new Error('Missing previous Pages capture');
 const state = JSON.parse(readFileSync(file, 'utf8'));
 if (state.source !== source || state.runKey !== runKey) throw new Error('Pages recovery belongs to another run');
 git(['fetch', '--no-tags', 'origin', 'master']);
 const current = git(['rev-parse', 'FETCH_HEAD']);
 const decision = pagesRestoreDecision({ ...state, current, subject: current === state.before ? '' : git(['show', '-s', '--format=%s', current]), releaseSha: current === state.before ? '' : git(['show', `${current}:release-sha.txt`]) });
 if (decision === 'restore') git(['push', `--force-with-lease=refs/heads/master:${current}`, 'origin', `${state.before}:refs/heads/master`]);
 if (git(['ls-remote', 'origin', 'refs/heads/master']).split(/\s/)[0] !== state.before) throw new Error('Pages HEAD changed during recovery');
 let served = false;
 for (let attempt = 0; attempt < 60; attempt++) {
  try {
   const response = await fetchImpl(`https://pcugame.github.io/release-sha.txt?recovery=${runKey}-${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
   served = response.ok && (await response.text()).trim() === state.previousSource;
  } catch { /* publication is asynchronous */ }
  if (served) break;
  await sleep(5000);
 }
 if (!served) throw new Error('Previous Pages source is not yet served; keep runtime stopped for recovery');
 console.log('previous_pages_content_verified=true');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 runPagesRecovery(...process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
