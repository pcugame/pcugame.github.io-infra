import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyPhase1Boundary, isPhase1RuntimeMarker, nodeDigest } from './phase1-architecture-boundary.mjs';

const historical = {
	rule: 'no-api-object-body-read', file: 'src/modules/public/image.service.ts',
	nodeText: 'storage.readRange(key, range)', line: 12, column: 1,
};
const edge = { ...historical, nodeSha256: nodeDigest(historical.nodeText), count: 1 };
const run = (violations, phase1 = true) => applyPhase1Boundary(violations, { phase1, edges: [edge] });

test('activates only for the complete unchanged Phase 1 runtime marker', () => {
	const marker = "#!/usr/bin/env node\n\nconsole.log('PCU_PHASE1_RUNTIME_V1');";
	assert.equal(isPhase1RuntimeMarker(marker + '\n'), true);
	for (const changed of [undefined, `// ${marker}`, `${marker}\nconsole.log('PHASE2');`, marker.replace('V1', 'V2')]) {
		assert.equal(isPhase1RuntimeMarker(changed), false);
		assert.equal(run([historical], isPhase1RuntimeMarker(changed)).violations.length, 1);
	}
});

test('permits the reviewed exact edge only in Phase 1', () => {
	assert.equal(run([historical]).violations.length, 0);
	assert.equal(run([historical], false).violations.length, 1);
});

test('rejects new authority, file, rule, and duplicate occurrences', () => {
	for (const added of [
		{ ...historical, nodeText: 'storage.readRange(otherKey, range)' },
		{ ...historical, file: 'src/modules/new/service.ts' },
		{ ...historical, rule: 'no-api-worker-import' },
		historical,
	]) assert.equal(run([historical, added]).violations.length, 1);
});

test('requires removal or review when a historical edge disappears or changes', () => {
	assert.equal(run([]).violations[0].rule, 'stale-phase1-architecture-boundary');
	assert.equal(run([{ ...historical, nodeText: 'storage.readRange(changed, range)' }]).violations.length, 2);
});

test('does not permit compatibility inventories to waive worker or SDK boundaries', () => {
	for (const rule of ['no-api-worker-import', 'no-worker-api-import', 'no-feature-storage-sdk-import']) {
		assert.throws(() => applyPhase1Boundary([], { phase1: true, edges: [{ ...edge, rule }] }));
	}
});
