import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dataset, evidenceFor, local, readLines, target } from './dataset.mjs';

function cli(script, args) {
	return spawnSync(process.execPath, [fileURLToPath(local(script)), ...args], { encoding: 'utf8' });
}
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

test('upload and fixed-source conditions remain separate for every case', async () => {
	const { labels, sources, pilot } = await dataset();
	const { generateEvidence } = await import(
		'../../../apps/api/src/modules/benchmark-worker/generate.ts'
	);
	for (const row of labels) {
		const shown = evidenceFor(row, sources).map((s, i) => ({
			id: 'S' + (i + 1),
			url: s.url,
			title: s.board ?? '캐릭터 랭킹',
			snippet: s.snippet,
			collectedAt: '2026-11-24T00:00:00.000Z',
		}));
		assert.deepEqual(generateEvidence(shown), shown, row.nickname);
	}
	assert.equal(pilot.length, 50);
	const acid = labels.find((r) => r.nickname === '약산수첩');
	assert.deepEqual(target(acid, 'default', 'no_search').scoreRange, [0, 20]);
	assert.deepEqual(target(acid, 'default', 'fixed').scoreRange, [35, 60]);
});

test('the pilot uses score differences and preserves pre-consensus agreement', async (t) => {
	const dir = await mkdtemp(join(tmpdir(), 'exhibition-review-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const rows = (await readLines(local('pilot-review.jsonl'))).map(({ id }) => ({
		id,
		default: 25,
		nonpolitical: 25,
		reason: 'test',
	}));
	const paths = ['a', 'b', 'resolution'].map((name) => join(dir, name));
	await writeFile(paths[0], jsonl(rows));
	for (const [disagreements, expectedStatus] of [
		[7, 0],
		[8, 1],
	]) {
		const other = rows.map((r, i) => ({ ...r, default: i < disagreements ? 36 : 35 }));
		const resolved = rows
			.slice(0, disagreements)
			.map((r) => ({ id: r.id, policy: 'default', score: null, reason: 'test' }));
		await writeFile(paths[1], jsonl(other));
		await writeFile(paths[2], jsonl(resolved));
		const result = cli('review.mjs', ['agreement', ...paths]);
		assert.equal(result.status, expectedStatus, result.stderr);
		assert.equal(JSON.parse(result.stdout).agreements.default, 50 - disagreements);
	}
});

test('numeric accuracy, fatal evidence errors and textual policy judgements are graded independently', async (t) => {
	const file = (name) => fileURLToPath(local('examples/default-fixed.' + name + '.jsonl'));
	const args = ['score', 'default', 'fixed', file('run'), file('grades')];
	const valid = cli('score.mjs', args);
	assert.equal(valid.status, 0, valid.stderr);
	const { overall, byKind, pairConsistency } = JSON.parse(valid.stdout);
	assert.equal(overall.fatal, 1);
	assert.equal(overall.inRange.numerator, 4);
	assert.deepEqual(overall.correctHold, { numerator: 0, denominator: 1, rate: 0 });
	assert.equal(overall.meanPointsOf8, 4.2);
	assert.equal(byKind['게임'].cases, 1);
	assert.equal(pairConsistency.denominator, 1);
	const dir = await mkdtemp(join(tmpdir(), 'exhibition-evidence-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const changed = await readLines(file('run'));
	changed[0].sources[0].snippet += ' altered';
	const badPath = join(dir, 'run.jsonl');
	await writeFile(badPath, jsonl(changed));
	const wrongEvidence = cli('score.mjs', [...args.slice(0, 3), badPath, file('grades')]);
	assert.match(wrongEvidence.stderr, /Evidence condition mismatch/);
	const stale = cli('score.mjs', ['score', 'nonpolitical', 'fixed', file('run'), file('grades')]);
	assert.match(stale.stderr, /stale grade/);
});
