import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Inspect the executable wrapper and every module it actually loads. Keeping
// the list derived from the wrapper prevents assertions drifting to dead code.
export function deploySource() {
  const wrapper = readFileSync(new URL('./deploy.sh', import.meta.url), 'utf8');
  const modules = wrapper.match(/^for module in ([a-z ]+); do$/m);
  assert.ok(modules, 'deploy.sh must declare its source-only modules');
  return [wrapper, ...modules[1].split(' ').map(name =>
    readFileSync(new URL(`./deploy/${name}.sh`, import.meta.url), 'utf8'))].join('\n');
}
