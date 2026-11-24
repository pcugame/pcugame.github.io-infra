import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import {
	countBy,
	dataset,
	evidenceFor,
	indexById,
	local,
	policies,
	readLines,
	target,
} from './dataset.mjs';

const { index, labels, pilot, sources, hash, communities, gameCounts, pairs } = await dataset();
const [command = 'validate', first, second, resolution] = process.argv.slice(2);
if (command === 'validate') {
	const old = await readLines(local('../benchmark-500.jsonl'));
	const oldIds = new Set(old.map((r) => r.id));
	assert(
		labels.every((r) => !oldIds.has(r.id)),
		'Candidate uses a previous edition ID',
	);
	console.log(
		JSON.stringify(
			{
				cases: labels.length,
				pilot: pilot.length,
				inputSha256: hash,
				games: gameCounts,
				sampling: countBy(
					labels.filter((r) => r.kind === '게임'),
					(r) => r.usage.method,
				),
				communities,
				politicalPairs: pairs.size,
			},
			null,
			2,
		),
	);
} else if (command === 'reference') {
	const row = index.get(first) ?? labels.find((r) => r.nickname === first);
	assert(row, 'Unknown nickname or case ID');
	const mode = second ?? 'no_search';
	for (const policy of policies) {
		const { referenceScore, scoreRange, action } = target(row, policy, mode);
		console.log(
			JSON.stringify({
				nickname: row.nickname,
				policy,
				referenceScore,
				scoreRange,
				action,
				answer: (mode === 'fixed' && row.fixed?.answer) || row.answer,
			}),
		);
	}
} else if (command === 'sheet' || command === 'packet') {
	assert(!first || ['pilot', 'all'].includes(first), 'Choose pilot or all');
	for (const { id, nickname } of first === 'all' ? labels : pilot) {
		const record =
			command === 'sheet'
				? { id, default: null, nonpolitical: null, reason: '' }
				: { id, nickname, evidence: evidenceFor(index.get(id), sources) };
		console.log(JSON.stringify(record));
	}
} else if (command === 'audit') {
	const reviewed = indexById(await readLines(first));
	assert.equal(reviewed.size, labels.length);
	const outside = [];
	for (const row of labels) {
		const r = reviewed.get(row.id);
		assert(r?.reason?.trim(), 'Missing full-set review rationale: ' + row.id);
		for (const policy of policies) {
			const score = r[policy];
			assert(score === null || (Number.isInteger(score) && score >= 0 && score <= 100), row.id);
			const { scoreRange } = target(row, policy, 'fixed');
			if (score === null || score < scoreRange[0] || score > scoreRange[1])
				outside.push({ id: row.id, policy, score, scoreRange, reason: r.reason });
		}
	}
	console.log(JSON.stringify({ reviewed: reviewed.size, forReconciliation: outside }, null, 2));
} else if (command === 'agreement') {
	// The independent sheets are collected before discussion. A consensus cannot raise the raw agreement.
	assert(
		first && second && (await realpath(first)) !== (await realpath(second)),
		'Supply two independent score sheets',
	);
	const sheets = await Promise.all(
		[first, second].map(async (path) => indexById(await readLines(path))),
	);
	const scores = (a, b) => (a === null || b === null ? a === b : Math.abs(a - b) <= 10);
	const differences = [];
	const agreements = { default: 0, nonpolitical: 0 };
	for (const sheet of sheets) assert.equal(sheet.size, pilot.length);
	for (const { id } of pilot) {
		const ratings = sheets.map((sheet) => sheet.get(id));
		for (const r of ratings) {
			assert(r?.reason?.trim(), 'Missing reviewer rationale for ' + id);
			for (const p of policies)
				assert(r[p] === null || (Number.isInteger(r[p]) && r[p] >= 0 && r[p] <= 100), id);
		}
		for (const p of policies) {
			const [a, b] = ratings.map((r) => r[p]);
			if (scores(a, b)) agreements[p]++;
			else differences.push({ id, policy: p, scores: [a, b] });
		}
	}
	if (resolution) {
		const adjudications = await readLines(resolution);
		assert.equal(adjudications.length, differences.length);
		for (const { id, policy } of differences) {
			const a = adjudications.find((r) => r.id === id && r.policy === policy);
			assert(
				a?.reason?.trim() &&
					(a.score === null || (Number.isInteger(a.score) && a.score >= 0 && a.score <= 100)),
				id,
			);
		}
	}
	const pass = agreements.default / pilot.length >= 0.85;
	console.log(
		JSON.stringify(
			{
				cases: pilot.length,
				agreements,
				differences,
				recalibrate: !pass,
				pendingAdjudications: resolution ? 0 : differences.length,
			},
			null,
			2,
		),
	);
	if (!pass || (differences.length && !resolution)) process.exitCode = 1;
} else
	throw Error(
		'Usage: node review.mjs validate|reference NAME [MODE]|sheet [all]|packet [all]|audit SCORES|agreement SCORE_A SCORE_B [CONSENSUS]',
	);
