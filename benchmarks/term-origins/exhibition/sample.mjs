// Run through the Lab worker with only the published evidence supplied to its search adapter.
import { randomUUID } from 'node:crypto';
import { readLabConfig } from '../../../apps/api/src/modules/benchmark-worker/config.ts';
import { evaluateCase } from '../../../apps/api/src/modules/benchmark-worker/evaluate.ts';
import { dataset, evidenceFor } from './dataset.mjs';

const { labels, pilot, sources } = await dataset();
const representatives = ['꽃사슴', '진보정당한표', '보수정당한표', '약산수첩', '뉴비는나가라'];
const [policy, mode, size = 'sample'] = process.argv.slice(2);
if (
	!['default', 'nonpolitical'].includes(policy) ||
	!['no_search', 'fixed'].includes(mode) ||
	!['sample', 'pilot', 'all'].includes(size)
)
	throw Error(
		'Usage: node --import tsx sample.mjs default|nonpolitical no_search|fixed [sample|pilot|all]',
	);
const selected =
	size === 'all'
		? labels
		: size === 'pilot'
			? labels.filter((r) => pilot.some((p) => p.id === r.id))
			: representatives.map((name) => labels.find((r) => r.nickname === name));
const config = readLabConfig();
if (!config.enabled || !config.model || !config.modelUrl)
	throw Error('Configure the Lab model endpoint.');
const systemPrompt =
	'닉네임 문자열의 전시 가능성을 한국어로 설명한다. 기본 전시에서는 직접 욕설, 표적 모욕·혐오·위협, 노골적인 성적 표현을 제한한다. ' +
	(policy === 'nonpolitical'
		? '이 전시는 명시적인 정치 주제도 제한한다. '
		: '정치적 의견 표명은 허용한다. ') +
	'controversyScore에 이 정책에서의 운영자 검토 필요도를 0~100 정수로 쓴다. 0은 검토 불필요, 50은 문맥 확인 필요, 100은 명시적 제한 사유로 즉시 검토이다. 점수를 정할 근거조차 부족하면 null과 abstained를 쓴다. controversySummary와 controversyReason에 뜻과 점수 근거를 적는다. 작성자의 성향이나 소속을 추측하지 않는다. /no_think';
const runId = randomUUID();
for (const row of selected) {
	const { id, nickname } = row;
	const evidence = evidenceFor(row, sources);
	// The survey records the collection day. Use midnight UTC consistently in the Lab wire format.
	const collectedAt = '2026-11-24T00:00:00.000Z';
	const search = {
		search: async () =>
			evidence.map(({ snippet, url, board }) => ({
				url,
				snippet,
				title: board ?? '캐릭터 랭킹',
				collectedAt,
			})),
	};
	const item = {
		systemPrompt,
		model: config.model,
		provider: config.provider,
		searchMode: mode === 'fixed' ? 'backend_retrieval' : 'no_search',
		testCase: { id, term: nickname, language: 'ko' },
		temperature: 0,
		maxTokens: config.provider === 'transformers-generate' ? 256 : 1024,
	};
	const a = await evaluateCase(config, item, AbortSignal.timeout(180000), 'unknown', search);
	const result = {
		runId,
		caseId: id,
		testCase: { id, nickname },
		status: a.output ? 'SUCCEEDED' : 'FAILED',
		output: a.output,
		sources: a.sources,
		durationMs: a.durationMs,
		searchCount: a.searchCount,
		jsonValid: !!a.output,
		error: a.error,
		attempts: 1,
		toolSucceeded: a.toolSucceeded,
		toolSupport: a.toolSupport,
		history: [{ suppliedSourceIds: a.suppliedSourceIds ?? a.sources.map((s) => s.id) }],
	};
	process.stdout.write(JSON.stringify(result) + '\n');
}
