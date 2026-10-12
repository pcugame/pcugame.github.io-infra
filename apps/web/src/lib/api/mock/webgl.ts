import {
  AllowWebglNetworkBatchSchema, ConnectionRule, CreateWebglNetworkBatchSchema, ProjectConnectionPolicy, CreateWebglNetworkRequestSchema, ReviewWebglNetworkRequestSchema, WebglDisplaySettingsSchema,
  inferWebglDisplayMode, resolveWebglDisplay, type WebglNetworkRequest,
} from '@pcu/contracts';
import { UNHANDLED, MockHttpError, type MockContext, type MockRequestOptions } from './context';
import { getProject, isRelated, projectCapabilities, projectExhibition, isStaff, bumpProjectVersion, mockWebglAnalysis } from './policy';
import { allowMethod, bodyObject, conflict, forbidden, missing, parseInput } from './common';

export function handleWebgl(ctx: MockContext, pathname: string, method: string, options: MockRequestOptions): unknown {
  let match = /^\/api\/me\/projects\/(\d+)\/webgl-display$/.exec(pathname);
  if (match) {
    allowMethod(method, 'GET', 'PUT'); ctx.requireUser();
    const project = getProject(ctx, Number(match[1]));
    if (project.isChangeRequestDraft) missing();
    if (!isStaff(ctx) && project.createdByUserId !== ctx.user?.id) forbidden('Only the creator or staff may edit WebGL display');
    if (method === 'PUT') {
      if (!projectCapabilities(ctx, project).canEditWebglDisplay) forbidden('Project modifications are closed for this exhibition');
      const input = parseInput(WebglDisplaySettingsSchema, bodyObject(options));
      Object.assign(project, input, { webglDisplayMode: inferWebglDisplayMode(input) });
      bumpProjectVersion(ctx, project);
    }
    const analysis = mockWebglAnalysis(project);
    return { webglDisplayMode: project.webglDisplayMode ?? 'legacy', webglDisplayWidth: project.webglDisplayWidth ?? null,
      webglDisplayHeight: project.webglDisplayHeight ?? null, analysis, effective: resolveWebglDisplay({ ...project, analysis }) };
  }
  match = /^\/api\/me\/projects\/(\d+)\/webgl-network-requests(\/batch)?$/.exec(pathname);
  const directMatch = /^\/api\/admin\/projects\/(\d+)\/webgl-network-requests(\/allow)?$/.exec(pathname);
  const direct = Boolean(directMatch);
  if (directMatch) match = directMatch;
  const admin = /^\/api\/admin\/webgl-network-requests(?:\/([^/]+)\/(approve|reject|revoke))?$/.exec(pathname);
  if (!match && !admin) return UNHANDLED;
  const actor = ctx.requireUser();
  const records = ctx.state.networkRequests as Record<string, WebglNetworkRequest>;
  if (admin) {
    ctx.requireAdmin();
    if (!admin[1]) { allowMethod(method, 'GET'); return { items: Object.values(records).sort((a,b) => b.createdAt.localeCompare(a.createdAt)), gameOrigin: windowOrigin(), policyVersion: null }; }
    allowMethod(method, 'POST');
    const row = records[admin[1]] ?? missing();
    const reason = parseInput(ReviewWebglNetworkRequestSchema, bodyObject(options)).reason;
    if (row.projectId === null || !ctx.state.projects[row.projectId]) conflict('The project no longer exists');
    const project = ctx.state.projects[row.projectId];
    const action = admin[2];
    const expected = action === 'revoke' ? 'APPROVED' : 'PENDING';
    if (row.state !== expected) conflict(`Only ${expected.toLowerCase()} requests can be ${action}d`);
    if (action === 'approve') {
      try { new ProjectConnectionPolicy([...Object.values(records).filter(r => r.projectId === project.id && r.state === 'APPROVED').map(r => r.origin), row.origin], [new URL(windowOrigin()).hostname]); }
      catch { conflict('Connection rules overlap, exceed sixteen rules, or include a protected host'); }
    }
    if (action !== 'reject') project.webglNetworkPolicyVersion = (project.webglNetworkPolicyVersion ?? 0) + 1;
    Object.assign(row, { state: action === 'approve' ? 'APPROVED' : action === 'reject' ? 'REJECTED' : 'REVOKED',
      reviewerId: actor.id, reviewReason: reason, reviewedAt: ctx.now(), policyVersion: project.webglNetworkPolicyVersion ?? 0,
      ...(action === 'revoke' ? { revokedAt: ctx.now() } : {}) });
    row.events.push({ id: crypto.randomUUID(), action: action === 'approve' ? 'APPROVE' : action === 'reject' ? 'REJECT' : 'REVOKE', actorId: actor.id, reason,
      policyVersion: row.policyVersion, createdAt: ctx.now() });
    return row;
  }
  if (direct) ctx.requireAdmin();
  const batch = Boolean(match![2]);
  allowMethod(method, ...(batch ? ['POST'] : direct ? ['GET'] : ['GET', 'POST']));
  const project = getProject(ctx, Number(match![1]));
  if (project.isChangeRequestDraft) missing();
  if (!direct && !isRelated(ctx, project)) forbidden('Only the creator or linked members may request connections');
  if (method === 'GET') return { items: Object.values(records).filter(r => r.projectId === project.id), gameOrigin: windowOrigin(), policyVersion: project.webglNetworkPolicyVersion ?? 0 };
  if (!direct && projectExhibition(ctx, project).isModificationEnabled === false) forbidden('Project modifications are closed for this exhibition');
  const parsed = batch ? (direct ? AllowWebglNetworkBatchSchema : CreateWebglNetworkBatchSchema).safeParse(bodyObject(options)) : CreateWebglNetworkBatchSchema.safeParse({ items: [parseInput(CreateWebglNetworkRequestSchema, bodyObject(options))] });
  if (!parsed.success) throw new MockHttpError(400, 'VALIDATION_ERROR', '연결 입력을 확인하세요.', parsed.error.issues.map(issue => ({ index: issue.path[1] ?? null, field: issue.path[2] ?? issue.path[0] ?? 'items', message: issue.message })));
  const errors = parsed.data.items.flatMap((input, index) => {
    if (ConnectionRule.parse(input.origin).includesHostname(new URL(windowOrigin()).hostname)) return [{ index, field: 'origin', message: '사이트·스토리지 보호 호스트는 신청할 수 없습니다.', conflict: false }];
    if (Object.values(records).some(r => r.projectId === project.id && r.origin === input.origin && ['PENDING', 'APPROVED'].includes(r.state))) return [{ index, field: 'origin', message: '이미 대기 중이거나 승인된 주소입니다.', conflict: true }];
    return [];
  });
  if (errors.length) throw new MockHttpError(errors.some(error => !error.conflict) ? 400 : 409, errors.some(error => !error.conflict) ? 'VALIDATION_ERROR' : 'CONFLICT', '연결 입력을 확인하세요.', errors);
  const reason = direct ? parseInput(AllowWebglNetworkBatchSchema, bodyObject(options)).reason : null;
  const version = project.webglNetworkPolicyVersion ?? 0;
  if (direct) {
    const approved = Object.values(records).filter(r => r.projectId === project.id && r.state === 'APPROVED');
    const overlaps = parsed.data.items.flatMap((input, index) => approved.some(row => ConnectionRule.parse(row.origin).overlaps(ConnectionRule.parse(input.origin))) ? [{ index, field: 'origin', message: '이미 승인된 연결 범위와 겹칩니다. 기존 승인을 확인하세요.' }] : []);
    if (overlaps.length) throw new MockHttpError(409, 'CONFLICT', '이미 승인된 연결 범위와 겹칩니다.', overlaps);
    if (approved.length + parsed.data.items.length > 16) conflict('작품당 최대 16개 연결을 허용할 수 있습니다.');
    new ProjectConnectionPolicy([...approved.map(row => row.origin), ...parsed.data.items.map(row => row.origin)], [new URL(windowOrigin()).hostname]);
  }
  const rows: WebglNetworkRequest[] = parsed.data.items.map((input, index) => ({ ...input, id: crypto.randomUUID(), projectId: project.id, originalProjectId: project.id, projectTitle: project.title,
    requesterId: actor.id, state: 'PENDING', reviewerId: null, reviewReason: null, createdAt: ctx.now(), reviewedAt: null,
    revokedAt: null, policyVersion: null, events: [],
    ...(direct ? { state: 'APPROVED' as const, reviewerId: actor.id, reviewReason: reason, reviewedAt: ctx.now(), policyVersion: version + index + 1,
      events: [{ id: crypto.randomUUID(), action: 'APPROVE' as const, actorId: actor.id, reason: reason!, policyVersion: version + index + 1, createdAt: ctx.now() }] } : {}),
  }));
  if (direct) project.webglNetworkPolicyVersion = version + rows.length;
  rows.forEach(row => { records[row.id] = row; });
  return batch ? { items: rows } : rows[0];
}
function windowOrigin() { return typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173'; }
