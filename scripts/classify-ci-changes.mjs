#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const flags = ['api', 'web', 'contracts', 'release', 'integration', 'install', 'full'];
const full = reason => ({ ...Object.fromEntries(flags.map(flag => [flag, true])), reasons: [reason] });

export function classifyPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return full('No changed paths: run the full baseline.');
  const plan = { ...Object.fromEntries(flags.map(flag => [flag, false])), reasons: [] };
  const reasons = new Set();
  for (const path of paths) {
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').includes('..')) {
      return full('Invalid changed path: run the full baseline.');
    }
    // Known documentation destinations only. Markdown elsewhere may be a fixture.
    if (path === 'README.md' || (path.startsWith('docs/') && path.endsWith('.md'))) {
      reasons.add('Documentation only requires the policy and CI regression checks.');
    } else if (path === 'package.json' || path === 'package-lock.json'
      || /(?:^|\/)(?:package\.json|package-lock\.json)$/.test(path)
      || path.startsWith('.github/workflows/') || path.startsWith('packages/')
      || path.startsWith('scripts/') || path === 'docker-compose.integration.yml'
      || (path.startsWith('apps/web/') && !path.startsWith('apps/web/src/') && !path.startsWith('apps/web/public/'))) {
      return full('Shared dependencies, CI/integration controls, or Web startup configuration changed.');
    } else if (path.startsWith('apps/web/src/') || path.startsWith('apps/web/public/')) {
      plan.web = plan.contracts = plan.install = true;
      reasons.add('Web source/assets: verify Web with its contracts prerequisite.');
    } else if (path.startsWith('apps/api/') || path.startsWith('apps/db/') || path.startsWith('server/')) {
      plan.api = plan.contracts = plan.release = plan.integration = plan.install = true;
      reasons.add('API/data plane/deployment: verify API, release controls, and service integration.');
    } else {
      return full('Unclassified path: run the full baseline.');
    }
  }
  if (plan.api && plan.web) return full('Both applications changed: run the full workspace baseline.');
  plan.reasons = [...reasons];
  return plan;
}

export function selectPlan({ eventName, baseSha, cwd, git = spawnSync }) {
  if (eventName !== 'pull_request') return full('Manual or unknown event: run the full baseline.');
  if (!/^[a-f0-9]{40}$/i.test(baseSha ?? '')) return full('Missing or invalid PR base SHA: run the full baseline.');
  // PR checkout is GitHub's merge commit. Compare its complete tree to the exact
  // event base, rather than a truncated API file list or only the PR head. This
  // conservatively includes changes introduced while merging an advanced base.
  const result = git('git', ['diff', '--name-only', '-z', '--no-renames', baseSha, 'HEAD', '--'], {
    cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    return full('Git diff unavailable: run the full baseline.');
  }
  const raw = result.stdout;
  if (raw.length && raw.at(-1) !== 0) return full('Incomplete Git path records: run the full baseline.');
  return classifyPaths(raw.length ? raw.toString('utf8').slice(0, -1).split('\0') : []);
}

export function writePlan(plan, { outputPath, summaryPath } = {}) {
  for (const flag of flags) {
    if (typeof plan[flag] !== 'boolean') throw new Error(`Invalid CI flag: ${flag}`);
  }
  const output = flags.map(flag => `${flag}=${plan[flag]}`).join('\n') + '\n';
  if (outputPath) appendFileSync(outputPath, output);
  const summary = ['## Selective CI', '', '| Check | Selected |', '| --- | --- |',
    ...flags.map(flag => `| ${flag} | ${plan[flag]} |`), '', ...plan.reasons.map(reason => `- ${reason}`), '',
    'Required `verify` and `integration` jobs always report a result. Production release behavior is unchanged.', '',
  ].join('\n');
  if (summaryPath) appendFileSync(summaryPath, summary);
  return output;
}

function main() {
  let baseSha;
  try {
    if (process.env.GITHUB_EVENT_PATH) baseSha = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))?.pull_request?.base?.sha;
  } catch {
    // Missing/unreadable event details must never narrow verification.
  }
  const plan = selectPlan({ eventName: process.env.GITHUB_EVENT_NAME, baseSha });
  console.log(writePlan(plan, { outputPath: process.env.GITHUB_OUTPUT, summaryPath: process.env.GITHUB_STEP_SUMMARY }));
  for (const reason of plan.reasons) console.log(reason);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
