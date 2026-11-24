import assert from 'node:assert/strict';

export const riskTypes = {
  gender: '성별', orientation: '성적 지향·정체성', sexual: '성적 대상화·가해',
  ethnicity: '인종·국적·민족', region: '지역', religion: '종교',
  disability: '장애', illness: '질병', appearance: '외모', housing: '주거',
  class: '경제적 지위', age: '연령', disaster: '참사·피해자', deceased: '고인',
  violence: '폭력·가학', history: '역사 왜곡', political: '정치',
  community: '게임·커뮤니티', family: '가족 모욕',
};
export const decisions = { accepted: '채택', held: '보류', excluded: '제외' };
export const statuses = { verified: '근거 검토', provisional: '추가 검토', unverified: '미확인' };
export const uses = {
  direct: '직접 사용', critical: '비판', quotation: '인용', reporting: '보도·연구 설명',
  self_reference: '자칭', ordinary: '일반 용법', unknown: '기능 미확인',
};
export const nonempty = s => typeof s === 'string' && s.trim().length > 0;
export const normalized = s => s.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
const member = (value, values, label) => assert(values.includes(value), `Invalid ${label}: ${value}`);
const textFields = (obj, fields, label) => {
  for (const field of fields) assert(nonempty(obj?.[field]), `Missing ${label}.${field}`);
};
const list = (value, label, required = true) => {
  assert(Array.isArray(value) && (!required || value.length > 0), `Missing ${label}`);
};
const unique = (values, label) => assert.equal(new Set(values).size, values.length, `Duplicate ${label}`);
const dated = value => assert(/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)), 'Invalid date');
export function validateTarget(target, label) {
  assert(target && typeof target === 'object', `Missing target: ${label}`);
  member(target.state, ['identified', 'none', 'unknown'], 'target state');
  assert(target.state === 'identified' ? nonempty(target.label) : target.label === null, `Target state/label mismatch: ${label}`);
}
export const eligible = entry => entry.review.decision === 'accepted' && entry.review.status === 'verified';

export function validateExpressions(entries, sources) {
  list(entries, 'entries');
  assert(sources && !Array.isArray(sources) && typeof sources === 'object', 'Missing sources');
  for (const [id, source] of Object.entries(sources)) {
    textFields(source, ['site', 'title', 'access', 'snippet', 'limitations'], `source ${id}`);
    member(source.kind, ['online_original', 'press', 'research', 'reference', 'user_report', 'authored'], 'source kind');
    member(source.accessStatus, ['retrieved', 'indexed', 'previous_review', 'user_supplied', 'authored'], 'source access');
    member(source.meaningScope, ['meaning', 'target_category', 'candidate_only', 'none'], 'meaning evidence scope');
    dated(source.checkedAt);
    list(source.surfaceForms, `source ${id}.surfaceForms`, false);
    unique(source.surfaceForms, `${id} source surface`);
    assert(source.surfaceForms.every(nonempty), `Empty source surface: ${id}`);
    list(source.nicknameForms, `source ${id}.nicknameForms`, false);
    unique(source.nicknameForms, `${id} nickname surface`);
    assert(source.nicknameForms.every(form => source.surfaceForms.includes(form)), `Unattested nickname evidence: ${id}`);
    if (['user_report', 'authored'].includes(source.kind)) {
      assert.equal(source.nicknameForms.length, 0, `Unverified nickname evidence: ${id}`);
      assert.equal(source.url, null, `Local source must not invent a URL: ${id}`);
      assert.equal(source.accessStatus, source.kind === 'user_report' ? 'user_supplied' : 'authored');
    } else {
      assert.equal(new URL(source.url).protocol, 'https:');
      assert(!['user_supplied', 'authored'].includes(source.accessStatus), `Invalid external source access: ${id}`);
    }
  }
  const refs = (evidence, label, required = true) => {
    list(evidence, label, required);
    unique(evidence.map(e => `${e.source}\0${e.locator}`), label);
    return evidence.map(ref => {
      textFields(ref, ['source', 'locator'], label);
      assert(Object.hasOwn(sources, ref.source), `Missing source: ${ref.source}`);
      return sources[ref.source];
    });
  };
  const ids = new Set();
  const surfaces = new Map();
  for (const entry of entries) {
    textFields(entry, ['id', 'expression'], 'entry');
    assert(/^ko-[a-z0-9-]+$/.test(entry.id), `Invalid meaning group ID: ${entry.id}`);
    assert(!ids.has(entry.id), `Duplicate meaning group: ${entry.id}`);
    ids.add(entry.id);
    textFields(entry.review, ['reason'], `review ${entry.id}`);
    member(entry.review.decision, Object.keys(decisions), 'decision');
    member(entry.review.status, Object.keys(statuses), 'review status');
    dated(entry.review.checkedAt);
    assert(entry.review.decision !== 'accepted' || entry.review.status === 'verified', `Unverified acceptance: ${entry.id}`);
    textFields(entry.research, ['query', 'note'], `research ${entry.id}`);
    list(entry.riskTypes, 'risk types');
    unique(entry.riskTypes, 'risk type');
    entry.riskTypes.forEach(type => member(type, Object.keys(riskTypes), 'risk type'));
    list(entry.ordinaryReadings, 'ordinary readings');
    assert(entry.ordinaryReadings.every(nonempty), `Empty ordinary reading: ${entry.id}`);
    list(entry.variants, 'variants');
    assert(entry.variants.some(v => v.text === entry.expression), `Missing representative surface: ${entry.id}`);
    unique(entry.variants.map(v => v.text), `${entry.id} variant`);
    let attested = false;
    for (const variant of entry.variants) {
      textFields(variant, ['text'], 'variant');
      member(variant.provenance, ['original', 'reported', 'elicited', 'user_report', 'synthetic'], 'surface provenance');
      const key = normalized(variant.text);
      assert(!surfaces.has(key) || surfaces.get(key) === entry.id, `Surface split across meaning groups: ${variant.text}`);
      surfaces.set(key, entry.id);
      const evidence = refs(variant.evidence, `surface ${entry.id}`);
      for (const source of evidence) {
        assert(source.surfaceForms.includes(variant.text), `Unattested surface: ${variant.text}`);
        const allowed = {
          original: ['online_original'], reported: ['press', 'research', 'reference'],
          elicited: ['research'], user_report: ['user_report'], synthetic: ['authored'],
        }[variant.provenance];
        assert(allowed.includes(source.kind), `Surface provenance exceeds source: ${entry.id}`);
      }
      if (!['synthetic', 'user_report'].includes(variant.provenance)) attested = true;
    }
    list(entry.interpretations, 'interpretations');
    let supported = false;
    for (const interpretation of entry.interpretations) {
      textFields(interpretation, ['reading'], 'interpretation');
      member(interpretation.confidence, ['supported', 'hypothesis'], 'interpretation confidence');
      validateTarget(interpretation.target, entry.id);
      const evidence = refs(interpretation.evidence, `meaning ${entry.id}`, interpretation.confidence === 'supported');
      if (interpretation.confidence === 'supported') {
        supported = true;
        assert(entry.review.status === 'verified', `Unverified meaning promoted: ${entry.id}`);
        assert(evidence.every(s => !['user_report', 'authored'].includes(s.kind)), `Report/synthesis used as confirmed meaning: ${entry.id}`);
        assert(evidence.every(s => ['meaning', 'target_category'].includes(s.meaningScope)), `Source supports candidates only: ${entry.id}`);
      }
    }
    if (eligible(entry)) assert(attested && supported, `Accepted group lacks evidence: ${entry.id}`);
    list(entry.contexts, 'contexts');
    for (const context of entry.contexts) {
      member(context.use, Object.keys(uses), 'usage context');
      textFields(context, ['description'], 'context');
      refs(context.evidence, `context ${entry.id}`);
    }
  }
  return new Map(entries.map(entry => [entry.id, entry]));
}
