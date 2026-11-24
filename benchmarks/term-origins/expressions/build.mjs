import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { decisions, statuses, riskTypes, uses, validateExpressions } from './validate.mjs';

export const read = async (name, base = import.meta.url) =>
  new TextDecoder('utf-8', { fatal: true }).decode(await readFile(new URL(name, base)));
export async function loadDatabase() {
  const rawEntries = await read('entries.json');
  const rawSources = await read('sources.json');
  const entries = JSON.parse(rawEntries), sources = JSON.parse(rawSources);
  validateExpressions(entries, sources);
  return { entries, sources, sourceSha256: createHash('sha256').update(rawEntries).update('\0').update(rawSources).digest('hex') };
}
export const counts = (rows, key) => rows.reduce((result, row) => {
  for (const value of [key(row)].flat()) result[value] = (result[value] ?? 0) + 1;
  return result;
}, {});
const code = value => '`' + value + '`';
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '&#124;').replaceAll('\n', ' ');
export const targetText = target => target.state === 'identified' ? target.label : target.state === 'none' ? '지칭 대상 없음' : '지칭 대상 미확인';
export function renderDatabase({ entries, sources, sourceSha256 }) {
  const summary = {
    groups: entries.length, decisions: counts(entries, e => e.review.decision),
    statuses: counts(entries, e => e.review.status), riskTypes: counts(entries, e => e.riskTypes),
    variants: entries.reduce((n, e) => n + e.variants.length, 0),
    sourceSha256, modelPerformance: 'unmeasured',
  };
  const refs = evidence => evidence.map(ref => `[${code(ref.source)}](#source-${ref.source.toLowerCase()}) (${escape(ref.locator)})`).join(' · ');
  const links = rows => rows.map(e => `[${code(e.id)} ${escape(e.expression)}](#${e.id})`).join(' · ');
  const lines = [
    '# 한국 웹 표현 DB 탐색', '',
    `검토한 의미군 ${summary.groups}개: 채택 ${summary.decisions.accepted ?? 0}개, 보류 ${summary.decisions.held ?? 0}개, 제외 ${summary.decisions.excluded ?? 0}개이다. 표기 ${summary.variants}개를 별도 의미군으로 합산하지 않는다.`, '',
    '[수록 기준](README.md) · [원자료](entries.json) · [출처 원자료](sources.json) · [닉네임 평가셋](../curated/cases.md)', '',
    '채택은 기록된 독법과 근거 범위의 채택이며, 문자열의 모든 사용이 혐오라는 판정이 아니다. 모델 성능은 미측정이다.', '',
    '## 검토 상태별 목록', '',
  ];
  for (const [key, label] of Object.entries(decisions)) lines.push(`### ${label}`, '', links(entries.filter(e => e.review.decision === key)), '');
  for (const [key, label] of Object.entries(statuses)) lines.push(`### ${label}`, '', links(entries.filter(e => e.review.status === key)), '');
  lines.push('## 유형별 목록', '', '여러 유형에 해당하는 의미군이 있으므로 유형별 건수의 합은 전체 의미군 수와 다르다.', '');
  for (const [key, label] of Object.entries(riskTypes)) {
    const selected = entries.filter(e => e.riskTypes.includes(key));
    if (selected.length) lines.push(`### ${label} (${selected.length})`, '', links(selected), '');
  }
  lines.push('## 개별 검토 기록', '');
  for (const e of entries) {
    lines.push(`<a id="${e.id}"></a>`, `### ${code(escape(e.expression))}`, '',
      `${code(e.id)} · ${decisions[e.review.decision]} · ${statuses[e.review.status]} · ${e.riskTypes.map(t => riskTypes[t]).join(' / ')}`, '',
      `검토 근거: ${escape(e.review.reason)}`, '', '표기 관측:', '');
    e.variants.forEach(v => lines.push(`- ${code(escape(v.text))} (${v.provenance}): ${refs(v.evidence)}`));
    lines.push('', '해석 후보:', '');
    e.interpretations.forEach(i => lines.push(`- ${i.confidence === 'supported' ? '근거 있음' : '가설'} · ${escape(i.reading)} 대상: ${escape(targetText(i.target))}. ${refs(i.evidence)}`.trimEnd()));
    lines.push('', ...e.contexts.map(c => `사용 맥락 (${uses[c.use]}): ${escape(c.description)} ${refs(c.evidence)}`), '',
      `일반 독법: ${e.ordinaryReadings.map(escape).join(' ')}`, '',
      `조사 단서: ${code(escape(e.research.query))}. ${escape(e.research.note)}`, '');
  }
  lines.push('## 출처 목록', '', '확인일은 출처의 게시일과 다르다. 검색 수록문·이전 검토 기록·사용자 제보를 본문 재열람으로 표기하지 않는다.', '');
  for (const [id, s] of Object.entries(sources)) lines.push(`<a id="source-${id.toLowerCase()}"></a>`,
    `### ${id}`, '', s.url ? `[${escape(s.site)} · ${escape(s.title)}](${s.url})` : `${escape(s.site)} · ${escape(s.title)}`, '',
    `${s.kind} · ${s.accessStatus} · 확인 ${s.checkedAt}`, '', escape(s.snippet), '', `입증 한계: ${escape(s.limitations)}`, '');
  return { 'index.md': lines.join('\n'), 'validation.json': JSON.stringify(summary, null, 2) + '\n' };
}
export async function buildDatabase(write = false) {
  const db = await loadDatabase();
  for (const [name, content] of Object.entries(renderDatabase(db))) {
    if (write) await writeFile(new URL(name, import.meta.url), content);
    else assert.equal(await read(name), content, `Stale artifact: expressions/${name}; run build.mjs --write`);
  }
  return db;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert(args.length === 0 || (args.length === 1 && args[0] === '--write'), 'Usage: build.mjs [--write]');
  const db = await buildDatabase(args[0] === '--write');
  console.log(JSON.stringify(JSON.parse(renderDatabase(db)['validation.json']), null, 2));
}
