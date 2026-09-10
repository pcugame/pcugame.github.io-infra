import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repository = 'pcugame/pcugame.github.io-infra';
const imagePattern = /^ghcr\.io\/pcugame\/pcu-graduationproject-v2-api@sha256:[a-f0-9]{64}$/;
export function validateManifest(manifest, source) {
  if (!/^[a-f0-9]{40}$/.test(source) || manifest?.source_sha !== source || !imagePattern.test(manifest?.image ?? '')) {
    throw new Error('Verified release manifest source or immutable image does not match dispatched master');
  }
  return manifest.image;
}
export async function resolveReleaseImage(source, api, unzip) {
  if (!/^[a-f0-9]{40}$/.test(source)) throw new Error('Invalid source SHA');
  const { workflow_runs: runs } = await api(`/repos/${repository}/actions/workflows/deploy-api.yml/runs?head_sha=${source}&status=success&per_page=100`);
  for (const run of runs) {
    if (run.head_sha !== source || run.head_branch !== 'master' || run.conclusion !== 'success' || !['push', 'workflow_dispatch'].includes(run.event)) continue;
    const { artifacts } = await api(`/repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`);
    const artifact = artifacts.find(item => item.name === `verified-api-release-${source}` && !item.expired);
    if (!artifact) continue;
    const zip = await api(`/repos/${repository}/actions/artifacts/${artifact.id}/zip`, true);
    return validateManifest(JSON.parse(await unzip(zip)), source);
  }
  return '';
}
async function main() {
  if (process.env.GITHUB_REPOSITORY !== repository || process.env.GITHUB_REF !== 'refs/heads/master') throw new Error('Release must run from production master');
  const api = async (endpoint, binary = false) => {
    const output = execFileSync('gh', ['api', endpoint], { maxBuffer: 4 * 1024 * 1024 });
    return binary ? output : JSON.parse(output.toString());
  };
  // Python's zipfile reads bytes from stdin without writing an untrusted archive.
  const unzip = async zip => execFileSync('python3', ['-c', 'import io,sys,zipfile; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.namelist()==["release-image.json"]; info=z.getinfo("release-image.json"); assert info.file_size < 4096; sys.stdout.buffer.write(z.read(info))'], { input: zip, encoding: 'utf8' });
  const image = await resolveReleaseImage(process.env.GITHUB_SHA, api, unzip);
  appendFileSync(process.env.GITHUB_OUTPUT, `image=${image}\n`);
  console.log(image ? `Resolved verified image for ${process.env.GITHUB_SHA}: ${image}` : 'No retained verified image found; the existing build workflow will build this exact source.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
