import { appendFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repository = 'pcugame/pcugame.github.io-infra';
const shaPattern = /^[a-f0-9]{40}$/;
export function recordEvidence(env, git) {
  return {
    version: 1, repository: env.GITHUB_REPOSITORY,
    runId: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT),
    source: git('HEAD'), tree: git('HEAD^{tree}'),
    api: env.CI_API === 'true', web: env.CI_WEB === 'true',
  };
}

// The synthetic PR merge and the final squash commit have different SHAs, but
// can contain exactly the same source tree. Only reuse those exact bytes.
export async function resolveCiEvidence(source, api, unzip) {
  if (!shaPattern.test(source)) throw new Error('Invalid release source');
  const target = await api(`/repos/${repository}/git/commits/${source}`);
  if (!shaPattern.test(target.tree?.sha ?? '')) throw new Error('Missing release tree');
  const result = { api: false, web: false, runs: [] };
  const { workflow_runs: runs } = await api(`/repos/${repository}/actions/workflows/pr-checks.yml/runs?status=success&per_page=100`);
  for (const run of runs) {
    if (run.status !== 'completed' || run.conclusion !== 'success'
      || run.head_repository?.full_name !== repository
      || !['pull_request', 'workflow_dispatch'].includes(run.event)
      || run.path !== '.github/workflows/pr-checks.yml') continue;
    const { artifacts } = await api(`/repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`);
    // A failed integration job can be rerun without rerunning successful verify.
    // Its evidence then belongs to an earlier attempt of this same immutable run.
    const candidates = artifacts.flatMap(item => {
      const match = item.name.match(new RegExp(`^ci-evidence-${run.id}-(\\d+)$`));
      const attempt = Number(match?.[1]);
      return !item.expired && Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= run.run_attempt
        ? [{ artifact: item, attempt }] : [];
    }).sort((a, b) => b.attempt - a.attempt);
    if (!candidates.length) continue;
    const { artifact, attempt } = candidates[0];
    const evidence = JSON.parse(await unzip(await api(`/repos/${repository}/actions/artifacts/${artifact.id}/zip`, true)));
    if (evidence.version !== 1 || evidence.repository !== repository || evidence.runId !== run.id
      || evidence.attempt !== attempt || !shaPattern.test(evidence.source ?? '')
      || evidence.tree !== target.tree.sha || typeof evidence.api !== 'boolean' || typeof evidence.web !== 'boolean') continue;
    const tested = await api(`/repos/${repository}/git/commits/${evidence.source}`);
    if (tested.tree?.sha !== evidence.tree) continue;
    result.api ||= evidence.api;
    result.web ||= evidence.web;
    result.runs.push(run.id);
    if (result.api && result.web) break;
  }
  return result;
}

async function main() {
  if (process.argv[2] === 'record') {
    const evidence = recordEvidence(process.env, ref => execFileSync('git', ['rev-parse', ref], { encoding: 'utf8' }).trim());
    writeFileSync('ci-evidence.json', JSON.stringify(evidence));
    return;
  }
  if (process.env.GITHUB_REPOSITORY !== repository || process.env.GITHUB_REF !== 'refs/heads/master') {
    throw new Error('CI reuse is only available to production master');
  }
  const api = async (endpoint, binary = false) => {
    const output = execFileSync('gh', ['api', endpoint], { maxBuffer: 8 * 1024 * 1024 });
    return binary ? output : JSON.parse(output.toString());
  };
  const unzip = async zip => execFileSync('python3', ['-c', 'import io,sys,zipfile; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.namelist()==["ci-evidence.json"]; assert z.getinfo("ci-evidence.json").file_size < 4096; sys.stdout.buffer.write(z.read("ci-evidence.json"))'], { input: zip, encoding: 'utf8' });
  const evidence = await resolveCiEvidence(process.env.GITHUB_SHA, api, unzip);
  appendFileSync(process.env.GITHUB_OUTPUT, `api=${evidence.api}\nweb=${evidence.web}\n`);
  const summary = `CI reuse for ${process.env.GITHUB_SHA}: API=${evidence.api}, Web=${evidence.web}; successful runs: ${evidence.runs.join(', ') || 'none'}.\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
