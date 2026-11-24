// Curate nicknames individually; the expression DB is never expanded into names.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { labNicknameInput } from '@pcu/contracts';
import { loadDatabase, renderDatabase, read, targetText } from '../expressions/build.mjs';
import { eligible, nonempty, normalized, validateExpressions, validateTarget } from '../expressions/validate.mjs';

const roles = { probe: '의미 탐지', ambiguous: '판단 유보', control: '오탐 점검' };
const kinds = { observed_nickname: '관측 닉네임', observed_expression: '관측 표현', authored: '합성' };
const code = value => '`' + value + '`';
const bag = s => [...s.replaceAll(' ', '')].sort().join('');
export function validateCases(cases, sources, entries) {
  const groups = validateExpressions(entries, sources);
  assert(Array.isArray(cases) && cases.length > 0, 'No curated cases');
  const ids = new Set(), names = new Set();
  return cases.flatMap(row => {
    const nickname = labNicknameInput(row.nickname).nickname;
    assert(typeof row.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(row.id), 'Invalid research ID');
    assert(!ids.has(row.id) && !names.has(normalized(row.nickname)), `Duplicate case: ${row.id}`);
    ids.add(row.id); names.add(normalized(row.nickname));
    assert(Object.hasOwn(roles, row.role) && Object.hasOwn(kinds, row.origin?.kind), row.id);
    for (const value of [row.mechanism, row.origin.note, row.interpretation, row.reasoning, row.uncertainty, row.whyIncluded])
      assert(nonempty(value), `Missing review field: ${row.id}`);
    validateTarget(row.target, row.id);
    assert(['confirmed', 'exploratory'].includes(row.evaluation), `Missing evaluation eligibility: ${row.id}`);
    assert(Array.isArray(row.meaningGroupIds) && row.meaningGroupIds.length > 0, `Missing meaning groups: ${row.id}`);
    assert.equal(new Set(row.meaningGroupIds).size, row.meaningGroupIds.length, `Duplicate group reference: ${row.id}`);
    for (const id of row.meaningGroupIds) {
      assert(groups.has(id), `Missing meaning group: ${id}`);
      if (row.evaluation === 'confirmed') assert(eligible(groups.get(id)), `Unverified group in confirmed evaluation: ${row.id}`);
    }
    assert(Array.isArray(row.clues) && row.clues.length > 0, row.id);
    for (const clue of row.clues) assert(nonempty(clue.text) && row.nickname.includes(clue.text) && nonempty(clue.meaning), `Invalid clue: ${row.id}`);
    assert(Array.isArray(row.meaningSources) && row.meaningSources.length > 0, row.id);
    const linkedSources = new Set(row.meaningGroupIds.flatMap(id => groups.get(id).interpretations.flatMap(i => i.evidence.map(e => e.source))));
    for (const key of [...row.meaningSources, ...(row.origin.source ? [row.origin.source] : [])]) {
      assert(Object.hasOwn(sources, key), `Missing source: ${key}`);
      if (row.evaluation === 'confirmed') assert(!['user_report', 'authored'].includes(sources[key].kind), `Unconfirmed source in evaluation: ${row.id}`);
    }
    if (row.evaluation === 'confirmed')
      assert(row.meaningSources.every(key => ['meaning', 'target_category'].includes(sources[key].meaningScope)), `Candidate-only meaning source in evaluation: ${row.id}`);
    assert(row.meaningSources.some(key => linkedSources.has(key)), `Case lacks linked meaning evidence: ${row.id}`);
    if (row.origin.kind === 'authored') assert(!row.origin.source, 'Authored case cited as observed');
    else {
      const source = sources[row.origin.source];
      assert(source && !['user_report', 'authored'].includes(source.kind), `Missing surface evidence: ${row.id}`);
      assert(source.surfaceForms.includes(row.nickname), `Unattested nickname: ${row.id}`);
      if (row.origin.kind === 'observed_nickname')
        assert(source.nicknameForms.includes(row.nickname), `Expression is not an observed nickname: ${row.id}`);
    }
    if (row.anagramOf) {
      assert.notEqual(row.anagramOf, row.nickname);
      assert.equal(bag(row.anagramOf), bag(row.nickname), `Invalid anagram: ${row.id}`);
    }
    // Unknown/absent targets do not change the role or imply harmlessness.
    // Exploratory material remains in the research notes, outside the confirmed review list.
    return row.evaluation === 'confirmed' ? [{ id: row.id, nickname }] : [];
  });
}
export function renderCases(cases, sources, entries) {
  const reviewed = validateCases(cases, sources, entries);
  const used = new Set(cases.flatMap(row => [...row.meaningSources, ...(row.origin.source ? [row.origin.source] : [])]));
  const sourceSubset = Object.fromEntries(Object.entries(sources).filter(([key]) => used.has(key)));
  const cards = cases.map((row, i) => [
    `## ${i + 1}. ${row.nickname}`, '',
    `${code(row.id)} · ${roles[row.role]} · ${kinds[row.origin.kind]} · ${row.evaluation} · ${row.mechanism}`, '',
    `의미군: ${row.meaningGroupIds.map(id => `[${code(id)}](../expressions/index.md#${id})`).join(' · ')}`, '',
    `해석 후보: ${row.interpretation}`, '', `지칭 대상: ${targetText(row.target)}`, '',
    ...row.clues.map(clue => `- ${code(clue.text)}: ${clue.meaning}`), '',
    `해석 근거: ${row.reasoning}`, '', `다른 독법·한계: ${row.uncertainty}`, '',
    `채택 이유: ${row.whyIncluded}`, '', `관측 범위: ${row.origin.note}`, '',
    `참고 자료: ${[...new Set([...(row.origin.source ? [row.origin.source] : []), ...row.meaningSources])].map(key => `[${sources[key].site} · ${sources[key].title}](${sources[key].url})`).join(' · ')}`, '',
  ].join('\n'));
  return {
    'sources.json': JSON.stringify(sourceSubset, null, 2) + '\n',
    'cases.md': ['# 닉네임 의미 해석 조사 자료', '',
      `검토 사례 ${cases.length}건, 근거 검토 사례 ${reviewed.length}건이다. 역할은 자동 차단 판정이 아니다. 합성 이름은 구성한 해석 가설이며 실제 유통·작성 의도의 증거가 아니다.`, '',
      '판단 유보는 복수 독법과 추가 문맥의 필요성, 오탐 점검은 이름에 실제로 드러난 일반 독법을 평가한다. 숨겨진 상황을 모델이 알고 있다고 가정하지 않는다. 모델 성능은 미측정이다.', '',
      '[원자료](cases.json) · [검토 기준](README.md)', '', ...cards].join('\n'),
  };
}
export async function buildCases(write = false) {
  const db = await loadDatabase();
  const { entries, sources } = db;
  const cases = JSON.parse(await read('cases.json', import.meta.url));
  const outputs = renderCases(cases, sources, entries);
  // Validate all source data before updating any of the generated artifacts.
  const allOutputs = {
    ...Object.fromEntries(Object.entries(renderDatabase(db)).map(([name, content]) => ['../expressions/' + name, content])),
    ...outputs,
  };
  for (const [name, content] of Object.entries(allOutputs)) {
    if (write) await writeFile(new URL(name, import.meta.url), content);
    else assert.equal(await read(name, import.meta.url), content, `Stale artifact: curated/${name}; run curated/build.mjs --write`);
  }
  return { cases: cases.length, sourceSha256: createHash('sha256').update(JSON.stringify(cases)).digest('hex'), modelPerformance: 'unmeasured' };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert(args.length === 0 || (args.length === 1 && args[0] === '--write'), 'Usage: build.mjs [--write]');
  console.log(JSON.stringify(await buildCases(args[0] === '--write'), null, 2));
}
