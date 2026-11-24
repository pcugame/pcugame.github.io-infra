import {
  LAB_ACTIVE_RUN_LIMIT, LAB_CASE_ATTEMPT_LIMIT, LAB_PAGE_SIZE, LabBetaUserSchema, LabCompareQuerySchema, LabCreateRunSchema, LabExportFormatSchema, LabOutputSchema, LabPageQuerySchema,
  LabCasesQuerySchema, LabResultsQuerySchema, LabRoleChangeSchema, LabUploadSchema, formatLabExport, parseLabUpload, LAB_DATASET_IDENTITY, LAB_NICKNAME_SYSTEM_PROMPT, LAB_NICKNAME_PROTOCOL,
  type LabCase, type LabDataset, type LabResult, type LabRun, type LabStatus,
} from '@pcu/contracts';
import { canUseLab } from '../../auth/roles';
import { allowMethod, bodyObject, conflict, forbidden, missing, parseInput } from './common';
import { effectiveMockUser, MOCK_USERS, MockHttpError, UNHANDLED, type MockContext, type MockRequestOptions } from './context';

type StoredDataset = { ownerId: number; info: LabDataset; cases: LabCase[] };
type StoredRun = { ownerId: number; info: LabRun; rows: LabResult[]; nextAt: number };
export interface MockLabState {
  roles: Record<number, 'USER' | 'BETA_TESTER'>;
  audits: { actorId: number; targetId: number; beforeRole: string; afterRole: string; at: string }[];
  datasets: StoredDataset[];
  runs: StoredRun[];
}

const STATUS: LabStatus = {
  enabled: true, mock: true, provider: 'mock', model: 'mock-nickname-evaluation',
  modelStatus: 'available', searchStatus: 'available', toolSupport: 'supported',
};

function pageOf<T>(rows: T[], page: number) {
  return rows.slice((page - 1) * LAB_PAGE_SIZE, page * LAB_PAGE_SIZE);
}
function matches(row: LabCase, q: string) {
  const search = q.toLowerCase();
  return [row.id, row.nickname].some(s => s.toLowerCase().includes(search));
}
async function sha256(text: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
function pending(testCase: LabCase): LabResult {
  return {
    caseId: testCase.id, testCase, status: 'PENDING', output: null, sources: [], durationMs: null, searchCount: 0,
    jsonValid: false, error: null, attempts: 0, toolSucceeded: false, toolSupport: 'supported', history: [],
  };
}
function advance(ctx: MockContext, job: StoredRun) {
  const run = job.info;
  if (run.status !== 'QUEUED' && run.status !== 'RUNNING') return;
  const now = Date.now();
  if (ctx.state.controls.worker === 'paused') {
    job.nextAt = now + 80;
    return;
  }
  if (now < job.nextAt) return;
  run.startedAt ??= ctx.now();
  run.status = 'RUNNING';
  const batch = Math.floor((now - job.nextAt) / 80) + 1;
  const rows = job.rows.filter(row => row.status === 'PENDING').slice(0, batch);
  job.nextAt += rows.length * 80;
  for (const row of rows) {
    row.durationMs = 80;
    row.attempts += 1;
    row.searchCount = run.searchMode === 'no_search' ? 0 : 1;
    row.toolSucceeded = run.searchMode === 'model_tool_call';
    if (ctx.state.controls.worker === 'fail') {
      row.status = 'FAILED';
      row.error = 'Mock 작업 실패';
      run.failed++;
    } else {
      const nickname = row.testCase.nickname;
      // Synthetic output depends on nickname alone, never human reference metadata.
      const abstained = nickname.includes('모호');
      const value = abstained ? null : (nickname.length * 7 + run.promptHash.charCodeAt(0)) % 101;
      row.output = LabOutputSchema.parse({
        schemaVersion: '2', nickname, interpretedTerm: null,
        reason: '화면 검증용 합성 판단, 실제 모델 평가 아님', score: value, confidence: 0, sourceIds: [], abstained,
      });
      row.jsonValid = true;
      row.status = 'SUCCEEDED';
      run.success++;
      if (value === null) run.stats.abstained++;
      else {
        const sum = (run.stats.meanScore ?? 0) * run.stats.scored;
        run.stats.scored++;
        run.stats.meanScore = (sum + value) / run.stats.scored;
      }
    }
    row.history.push({ attempt: row.attempts, status: row.status, at: ctx.now(), mock: true });
  }
  if (run.failed + run.success + run.cancelled === run.size) {
    run.status = 'COMPLETED';
    run.completedAt = ctx.now();
  }
}

export async function handleLab(ctx: MockContext, pathname: string, method: string, options: MockRequestOptions, path: string) {
  if (!pathname.startsWith('/api/lab/')) return UNHANDLED;
  const actor = ctx.requireUser();
  if (!canUseLab(actor.role)) forbidden();
  const state = ctx.state.lab ??= { roles: {}, audits: [], datasets: [], runs: [] } as MockLabState;
  const query = Object.fromEntries(new URL(path, 'http://mock.local').searchParams);
  const visible = (record: { ownerId: number }) => record.ownerId === actor.id || actor.role === 'ADMIN';
  const dataset = (id: string) => state.datasets.find(item => item.info.id === id && visible(item)) ?? missing('Dataset not found');
  const run = (id: string) => state.runs.find(item => item.info.id === id && visible(item)) ?? missing('Run not found');
  const ownedActive = (ownerId: number) => state.runs.filter(r => r.ownerId === ownerId && ['QUEUED', 'RUNNING'].includes(r.info.status)).length;
  if (pathname === '/api/lab/status') { allowMethod(method, 'GET'); return STATUS; }
  if (pathname.startsWith('/api/lab/beta-users')) {
    if (actor.role !== 'ADMIN') forbidden();
    if (pathname === '/api/lab/beta-users') {
      allowMethod(method, 'GET');
      const { page, q } = parseInput(LabPageQuerySchema, query);
      const term = q.toLowerCase();
      const users = Object.values(MOCK_USERS).map(u => effectiveMockUser(ctx.state, u)).filter(u =>
        (u.role === 'USER' || u.role === 'BETA_TESTER') && (u.name.toLowerCase().includes(term) || u.email.toLowerCase().includes(term) || String(u.id) === q));
      return { items: pageOf(users.sort((a, b) => a.id - b.id), page).map(user => LabBetaUserSchema.parse(user)) };
    }
    allowMethod(method, 'PATCH');
    const { role } = parseInput(LabRoleChangeSchema, bodyObject(options));
    const id = Number(/^\/api\/lab\/beta-users\/(\d+)$/.exec(pathname)?.[1]);
    const target = Object.values(MOCK_USERS).find(u => u.id === id && (u.role === 'USER' || u.role === 'BETA_TESTER')) ?? missing('Eligible user not found');
    const from = effectiveMockUser(ctx.state, target).role;
    if (from !== role) {
      state.roles[id] = role;
      state.audits.push({ actorId: actor.id, targetId: id, beforeRole: from, afterRole: role, at: ctx.now() });
    }
    return LabBetaUserSchema.parse(effectiveMockUser(ctx.state, target));
  }
  if (pathname === '/api/lab/datasets') {
    allowMethod(method, 'GET', 'POST');
    if (method === 'GET') {
      const { page } = parseInput(LabPageQuerySchema, query);
      return pageOf(state.datasets.filter(visible).map(record => record.info), page);
    }
    const input = parseInput(LabUploadSchema, bodyObject(options));
    const { name } = input;
    let cases: LabCase[];
    try { cases = parseLabUpload(input); }
    catch (error) { throw new MockHttpError(400, 'VALIDATION_ERROR', error instanceof Error ? error.message : 'Invalid JSONL'); }
    const identity = LAB_DATASET_IDENTITY;
    const hash = await sha256(JSON.stringify({ ...identity, cases }));
    const existing = state.datasets.find(d => d.ownerId === actor.id && d.info.hash === hash);
    if (existing) return existing.info;
    const info = { id: crypto.randomUUID(), name, hash, count: cases.length, ...identity, createdAt: ctx.now() };
    state.datasets.unshift({ ownerId: actor.id, cases, info });
    return info;
  }
  const caseList = /^\/api\/lab\/datasets\/([^/]+)\/cases$/.exec(pathname);
  if (caseList) {
    allowMethod(method, 'GET');
    const { q, page, split } = parseInput(LabCasesQuerySchema, query);
    const rows = dataset(caseList[1]).cases.filter(c => matches(c, q) && (!split || c.split === split));
    return { items: pageOf(rows, page), total: rows.length };
  }
  for (const record of state.runs.filter(visible)) advance(ctx, record);
  if (pathname === '/api/lab/runs') {
    allowMethod(method, 'GET', 'POST');
    if (method === 'GET') return pageOf(state.runs.filter(visible).map(r => r.info), parseInput(LabPageQuerySchema, query).page);
    const input = parseInput(LabCreateRunSchema, bodyObject(options));
    if (input.model !== STATUS.model) throw new MockHttpError(400, 'VALIDATION_ERROR', 'Unknown model');
    if (ownedActive(actor.id) >= 3) conflict('Three evaluations are already queued or running');
    const d = dataset(input.datasetId);
    const { caseIds, ...settings } = input;
    const byId = new Map(d.cases.filter(c => !input.split || c.split === input.split).map(c => [c.id, c]));
    const cases = caseIds ? caseIds.map(id => byId.get(id)) : [...byId.values()].slice(0, input.size);
    if (cases.length !== input.size || cases.some(c => !c)) throw new MockHttpError(400, 'VALIDATION_ERROR', 'Invalid case selection');
    const id = crypto.randomUUID();
    state.runs.unshift({
      ownerId: actor.id, nextAt: Date.now() + 300, rows: cases.map(c => pending(c!)),
      info: { ...settings, id, schemaVersion: d.info.schemaVersion, evaluationProtocol: LAB_NICKNAME_PROTOCOL, datasetVersion: d.info.version, datasetHash: d.info.hash, systemPrompt: LAB_NICKNAME_SYSTEM_PROMPT, promptHash: await sha256(LAB_NICKNAME_SYSTEM_PROMPT), provider: STATUS.provider,
        status: 'QUEUED', createdAt: ctx.now(), startedAt: null, completedAt: null, success: 0, failed: 0, cancelled: 0,
        stats: { meanScore: null, scored: 0, abstained: 0 } },
    });
    return { runId: id };
  }
  if (pathname === '/api/lab/compare') {
    allowMethod(method, 'GET');
    const { left, right, q, page } = parseInput(LabCompareQuerySchema, query);
    if (run(left).info.datasetHash !== run(right).info.datasetHash || run(left).info.schemaVersion !== run(right).info.schemaVersion) throw new MockHttpError(400, 'VALIDATION_ERROR', 'Compare runs from the same dataset snapshot and schema');
    const sides = [run(left), run(right)].map(r => new Map(r.rows.map(row => [row.caseId, row])));
    const ids = [...new Set(sides.flatMap(map => [...map.values()].filter(r => matches(r.testCase, q)).map(r => r.caseId)))].sort();
    return { items: pageOf(ids, page).map(caseId => ({ caseId, left: sides[0].get(caseId) ?? null, right: sides[1].get(caseId) ?? null })), total: ids.length };
  }
  const detail = /^\/api\/lab\/runs\/([^/]+)(?:\/(results|cancel|retry|export))?$/.exec(pathname);
  if (!detail) return UNHANDLED;
  const current = run(detail[1]);
  const action = detail[2];
  if (!action) { allowMethod(method, 'GET'); return current.info; }
  if (action === 'results') {
    allowMethod(method, 'GET');
    const { page, q, status } = parseInput(LabResultsQuerySchema, query);
    const rows = current.rows.filter(r => (!status || r.status === status) && matches(r.testCase, q));
    return { items: pageOf(rows, page), total: rows.length };
  }
  if (action === 'export') {
    allowMethod(method, 'GET');
    return formatLabExport(current.info, current.rows, parseInput(LabExportFormatSchema, query.format));
  }
  allowMethod(method, 'POST');
  const info = current.info;
  if (action === 'cancel') {
    if (info.status === 'COMPLETED') conflict('Run already completed');
    if (info.status !== 'CANCELLED') {
      for (const row of current.rows) if (row.status === 'PENDING' || row.status === 'RUNNING') { row.status = 'CANCELLED'; info.cancelled++; }
      info.status = 'CANCELLED';
      info.completedAt = ctx.now();
    }
  } else {
    const failed = current.rows.filter(r => r.status === 'FAILED' && r.attempts < LAB_CASE_ATTEMPT_LIMIT);
    if (!['COMPLETED','CANCELLED'].includes(info.status) || !failed.length || ownedActive(current.ownerId) >= LAB_ACTIVE_RUN_LIMIT) conflict('No eligible retry');
    for (const row of failed) { row.status = 'PENDING'; row.error = null; }
    info.failed -= failed.length;
    info.status = 'QUEUED';
    info.completedAt = null;
    current.nextAt = Date.now() + 300;
  }
  return { runId: info.id };
}
