import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseLabJsonl } from '@pcu/contracts';

export const policies = ['default', 'nonpolitical'];
const directory = new URL('./', import.meta.url);
export const local = (name) => new URL(name, directory);
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export async function readLines(path) {
	const data = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path));
	return data
		.trimEnd()
		.split(/\r?\n/)
		.map((s, i) => {
			try {
				return JSON.parse(s);
			} catch {
				throw Error('Invalid JSON on line ' + (i + 1) + ' of ' + path);
			}
		});
}
export function indexById(rows) {
	const index = new Map(rows.map((r) => [r.id, r]));
	assert.equal(index.size, rows.length, 'Duplicate ID');
	return index;
}
export function target(row, policy, mode) {
	assert(policies.includes(policy) && ['no_search', 'fixed'].includes(mode));
	return ((mode === 'fixed' && row.fixed?.policies) || row.policies)[policy];
}
export function countBy(rows, key) {
	const counts = {};
	for (const row of rows) {
		const name = key(row);
		counts[name] = (counts[name] ?? 0) + 1;
	}
	return counts;
}
export const rankings = {
	maple: { host: 'maplestory.nexon.com', title: '메이플스토리 오로라 종합', column: '캐릭터명' },
	baram: { host: 'baram.nexon.com', title: '바람의나라 연 전사', column: '캐릭터명' },
	latale: { host: 'naver.latale.com', title: '라테일 개인 초월2 (world=1)', column: '대표 캐릭터명' },
};
export function evidenceFor(row, sources) {
	const evidence = [];
	if (row.kind === '게임') {
		const { game, observed, rank, url } = row.usage;
		const { title, column } = rankings[game];
		evidence.push({
			url,
			snippet: `${title} · ${rank}위 · ${column} ${row.nickname} (${observed} 수집)`,
		});
	}
	for (const key of row.meaningSources) {
		const { url, snippet, access, board, published } = sources[key];
		const passage = key === row.usage.communitySource ? (row.usage.excerpt ?? snippet) : snippet;
		evidence.push({ url, snippet: passage, access, board, published });
	}
	return evidence;
}
export async function dataset() {
	const [raw, labels, sourcesText, pilot] = await Promise.all([
		readFile(local('candidate.jsonl'), 'utf8'),
		readLines(local('candidate.labels.jsonl')),
		readFile(local('sources.json'), 'utf8'),
		readLines(local('pilot-review.jsonl')),
	]);
	assert.deepEqual(
		parseLabJsonl(raw),
		labels.map(({ id, nickname }) => ({ id, nickname })),
	);
	const sources = JSON.parse(sourcesText);
	const index = indexById(labels);
	assert.deepEqual(
		countBy(labels, (r) => r.kind),
		{ 게임: 350, 재구성: 150 },
	);
	const games = labels.filter((r) => r.kind === '게임');
	const gameCounts = countBy(games, (r) => r.usage.game);
	assert(Object.keys(gameCounts).length >= 3 && Object.values(gameCounts).every((n) => n <= 150));
	for (const [id, s] of Object.entries(sources)) {
		assert(s.site && s.board && s.title && s.snippet?.trim() && s.access, id);
		assert.equal(new URL(s.url).protocol, 'https:');
	}
	const pairs = new Map();
	for (const r of labels) {
		const { id, nickname, usage } = r;
		assert.equal(id, 'ex-' + digest(nickname).slice(0, 12));
		assert(
			[r.answer, r.acceptable, r.penalize].every((s) => s?.trim()),
			id,
		);
		assert(Array.isArray(r.meaningSources) && r.meaningSources.every((k) => sources[k]), id);
		if (r.kind === '게임') {
			assert(
				Number.isInteger(usage.rank) && usage.rank > 0 && /^\d{4}-\d{2}-\d{2}$/.test(usage.observed),
				id,
			);
			assert(['range', 'targeted'].includes(usage.method), id);
			assert.equal(new URL(usage.url).hostname, rankings[usage.game].host);
			assert.deepEqual(Object.keys(usage).sort(), ['game', 'method', 'observed', 'rank', 'url']);
		} else {
			assert(
				r.meaningSources.includes(usage.communitySource) && sources[usage.communitySource].published,
				id,
			);
			assert(usage.original && usage.original !== nickname && usage.change?.trim(), id);
			assert.equal(
				index.get(usage.namingExample)?.kind,
				'게임',
				'Missing naming example for ' + nickname,
			);
		}
		for (const policy of policies)
			for (const mode of ['fixed', 'no_search']) {
				const { scoreRange, referenceScore, action } = target(r, policy, mode);
				assert(scoreRange.length === 2 && scoreRange.every(Number.isInteger), id);
				assert(0 <= scoreRange[0] && scoreRange[0] <= scoreRange[1] && scoreRange[1] <= 100, id);
				assert(
					Number.isInteger(referenceScore) &&
						referenceScore >= scoreRange[0] &&
						referenceScore <= scoreRange[1],
					id,
				);
				assert(['허용', '보류', '제한'].includes(action), id);
				if (action === '제한')
					assert(r.meaningSources.length, 'Missing meaning evidence for ' + nickname);
			}
		assert(!r.fixed || r.fixed.answer?.trim(), id);
		for (const f of r.conditionalFlags) {
			assert(['정치 주제', '특정 맥락에서 비하', '특정 공간에서 반발 확인'].includes(f.flag), id);
			assert(f.scope && f.action && f.trigger && r.meaningSources.includes(f.evidence), id);
			assert(
				f.visibleIn?.includes('fixed') && f.visibleIn.every((m) => ['no_search', 'fixed'].includes(m)),
				id,
			);
		}
		if (r.pair) pairs.set(r.pair, [...(pairs.get(r.pair) ?? []), r]);
	}
	assert(pairs.size, 'Missing political contrast pairs');
	for (const group of pairs.values()) {
		assert.equal(group.length, 2);
		const [a, b] = group;
		assert.deepEqual(a.policies, b.policies);
		assert.deepEqual(a.fixed?.policies, b.fixed?.policies);
		assert.equal(a.nickname.replace(/진보|보수/, '_'), b.nickname.replace(/진보|보수/, '_'));
	}
	const communities = countBy(
		labels.filter((r) => r.kind === '재구성'),
		(r) => sources[r.usage.communitySource].site,
	);
	assert.deepEqual(
		Object.keys(communities).sort(),
		['일베', '디시인사이드', '클리앙', '오늘의유머', '여성시대', '워마드', '더쿠'].sort(),
	);
	assert.equal(indexById(pilot).size, 50);
	assert.deepEqual(
		countBy(pilot, (r) => index.get(r.id).kind),
		{ 게임: 35, 재구성: 15 },
	);
	for (const { id, nickname, evidence } of pilot) {
		assert.equal(index.get(id).nickname, nickname);
		assert.deepEqual(evidence, evidenceFor(index.get(id), sources), id);
	}
	return { index, sources, pilot, labels, gameCounts, communities, hash: digest(raw), pairs };
}
