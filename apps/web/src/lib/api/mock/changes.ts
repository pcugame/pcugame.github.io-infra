import {
  CreateProjectChangeSchema, UpdateProjectChangeSchema, RejectProjectChangeSchema,
  type ProjectChangeDetail, type ProjectChangeSummary, type ProjectChangeValues,
} from '@pcu/contracts';
import { UNHANDLED, type MockContext, type MockProject, type MockRequestOptions } from './context';
import { allowMethod, bodyObject, conflict, forbidden, missing, parseInput } from './common';
import { createSubmission } from './uploads';

interface ChangeRecord extends ProjectChangeDetail { dueAt?: number }
function records(ctx: MockContext) { return ctx.state.changeRequests as Record<string, ChangeRecord>; }
function staff(ctx: MockContext) { return ['ADMIN', 'OPERATOR'].includes(ctx.requireUser().role); }
function related(project: MockProject, userId: number) {
  return project.createdByUserId === userId || project.members.some(m => m.userId === userId);
}
function source(ctx: MockContext, row: ChangeRecord) { return row.projectId === null ? undefined : ctx.state.projects[row.projectId]; }
function validSource(ctx: MockContext, row: ChangeRecord) {
  const project = source(ctx, row);
  return project && Number(project.version ?? 1) === row.baseVersion && related(project, row.actorId) ? project : null;
}
function detail(ctx: MockContext, row: ChangeRecord): ProjectChangeDetail {
  const stage = row.stagingProjectId === null ? undefined : ctx.state.projects[row.stagingProjectId];
  const submission = row.stagingProjectId === null ? undefined : ctx.state.submissions[row.stagingProjectId];
  const { dueAt: _dueAt, ...out } = row;
  void _dueAt;
  return { ...out, items: submission?.items ?? row.items,
    stagedAssets: stage ? stage.assets.map(a => ({ id: a.id, kind: a.kind, originalName: a.originalName,
      previewUrl: 'image' in a ? a.image.original.url : 'url' in a ? a.url : a.downloadUrl })) : row.stagedAssets };
}
function summary(row: ChangeRecord): ProjectChangeSummary {
  const { before: _before, changes: _changes, stagingProjectId: _stage, submissionId: _submission, items: _items, stagedAssets: _assets, dueAt: _due, ...out } = row;
  void [_before, _changes, _stage, _submission, _items, _assets, _due];
  return out;
}
function discardStage(ctx: MockContext, row: ChangeRecord) {
  if (row.stagingProjectId === null) return;
  const stage = ctx.state.projects[row.stagingProjectId];
  if (stage) row.stagedAssets = stage.assets.map(a => ({ id: a.id, kind: a.kind, originalName: a.originalName, previewUrl: '' }));
  delete ctx.state.projects[row.stagingProjectId];
  delete ctx.state.submissions[row.stagingProjectId];
  for (const session of Object.values(ctx.state.sessions)) if (session.owner?.type === 'PROJECT' && session.owner.id === row.stagingProjectId) session.state = 'CANCELLED';
  row.stagingProjectId = null; row.submissionId = null; row.items = [];
}
function ready(ctx: MockContext, row: ChangeRecord) {
  const project = source(ctx, row) ?? conflict('The source project no longer exists');
  const stage = row.stagingProjectId === null ? undefined : ctx.state.projects[row.stagingProjectId];
  if (row.stagingProjectId !== null) {
    const submission = ctx.state.submissions[row.stagingProjectId];
    if (!submission || submission.items.some((item: { state: string }) => item.state !== 'READY')) conflict('Every selected file must finish processing before submission');
  }
  const removed = new Set(row.changes.removeAssetIds ?? []);
  if ([...removed].some(id => !project.assets.some(a => a.id === id))) forbidden('Removed assets must belong to this project');
  for (const asset of stage?.assets ?? []) if (['GAME', 'POSTER'].includes(asset.kind))
    for (const original of project.assets.filter(a => a.kind === asset.kind)) removed.add(original.id);
  const remaining = [...project.assets.filter(a => !removed.has(a.id)), ...(stage?.assets ?? [])];
  if (remaining.filter(a => a.kind === 'VIDEO').length > 5 || remaining.filter(a => ['DOCUMENT', 'ATTACHMENT'].includes(a.kind)).length > 5) conflict('A project supports at most five videos and five materials');
  const poster = row.changes.posterAssetId;
  if (poster !== undefined && poster !== null && !remaining.some(a => a.id === poster && ['POSTER', 'IMAGE'].includes(a.kind))) forbidden('Poster must belong to this project');
  const order = row.changes.videoAssetIds;
  const videos = remaining.filter(a => a.kind === 'VIDEO');
  if (order && (order.length !== videos.length || new Set(order).size !== videos.length || order.some(id => !videos.some(a => a.id === id)))) conflict('Video order must contain every retained video exactly once');
  return { project, stage, remaining };
}
function apply(ctx: MockContext, row: ChangeRecord) {
  if (!validSource(ctx, row)) { row.state = 'CONFLICT'; row.error = 'Project changed or requester no longer has access'; discardStage(ctx, row); return; }
  const { project, stage, remaining } = ready(ctx, row);
  if (row.kind === 'DELETE') {
    delete ctx.state.projects[project.id];
    delete ctx.state.submissions[project.id];
    for (const request of Object.values(records(ctx))) if (request.projectId === project.id) request.projectId = null;
    for (const request of Object.values(ctx.state.networkRequests)) if (request.projectId === project.id) request.projectId = null;
    for (const session of Object.values(ctx.state.sessions)) if (session.owner?.type === 'PROJECT' && session.owner.id === project.id) session.state = 'CANCELLED';
  } else {
    const changes = row.changes;
    for (const key of ['title', 'summary', 'description', 'githubUrl', 'externalLinks', 'platforms', 'hardwareRequirements'] as const)
      if (changes[key] !== undefined) Object.assign(project, { [key]: changes[key] });
    if (changes.members) project.members = changes.members.map((m, index) => ({ ...m, id: Date.now() + index, sortOrder: index,
      userId: m.studentId === '2088099' ? 3 : m.studentId === '2088100' ? 4 : m.studentId === '2088101' ? 5 : null }));
    project.assets = remaining;
    const posterId = changes.posterAssetId !== undefined ? changes.posterAssetId : stage?.posterAssetId ?? project.posterAssetId;
    const poster = project.assets.find(a => a.id === posterId && 'image' in a);
    if (poster && 'image' in poster) { project.posterAssetId = poster.id; project.poster = poster.image; }
    else { delete project.poster; delete project.posterAssetId; }
    if (changes.removeWebgl) { delete project.webglUrl; delete project.webglDeployment; }
    if (stage?.webglUrl) { project.webglUrl = stage.webglUrl; project.webglDeployment = stage.webglDeployment; }
    if (changes.videoAssetIds) project.assets.forEach(a => { if (a.kind === 'VIDEO') a.videoSortOrder = changes.videoAssetIds!.indexOf(a.id); });
    project.videos = project.assets.filter((a): a is Extract<MockProject['assets'][number], { url: string }> => a.kind === 'VIDEO' && 'url' in a).sort((a, b) => (a.videoSortOrder ?? 0) - (b.videoSortOrder ?? 0)).map((a, index) => ({
      assetId: a.id, url: a.playbackStatus === 'READY' ? a.playbackUrl ?? a.url : undefined, originalDownloadUrl: a.originalDownloadUrl ?? a.url,
      playbackStatus: a.playbackStatus ?? 'READY', sortOrder: index, role: index === 0 ? 'MAIN' as const : 'ADDITIONAL' as const, mimeType: 'video/webm',
    }));
    project.video = project.videos[0] ?? null;
    project.attachments = project.assets.flatMap(a => (a.kind === 'DOCUMENT' || a.kind === 'ATTACHMENT') && 'downloadUrl' in a ? [{ assetId: a.id, kind: a.kind, originalName: a.originalName, sizeBytes: a.size, mimeType: a.mimeType, downloadUrl: a.downloadUrl }] : []);
    rewriteStageUrls(project, project.id);
    project.version = Number(project.version ?? 1) + 1;
    project.updatedAt = ctx.now();
  }
  const completedAssets = detail(ctx, row).stagedAssets;
  discardStage(ctx, row);
  row.stagedAssets = completedAssets;
  rewriteStageUrls(row.stagedAssets, project.id);
  row.state = 'COMPLETED'; row.error = null; row.completedAt = ctx.now(); row.updatedAt = ctx.now();
}
function rewriteStageUrls(value: unknown, projectId: number): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && item.includes('mock_project=')) {
      const url = new URL(item, 'http://mock.local'); url.searchParams.set('mock_project', String(projectId));
      (value as Record<string, unknown>)[key] = /^https?:/.test(item) ? url.toString() : url.pathname + url.search;
    } else rewriteStageUrls(item, projectId);
  }
}
export function advanceChangeJobs(ctx: MockContext) {
  for (const row of Object.values(records(ctx))) if (row.state === 'APPLYING' && (row.dueAt ?? Infinity) <= Date.now() && ctx.state.controls.worker !== 'paused') {
    if (ctx.state.controls.worker === 'fail') { row.state = 'FAILED'; row.error = 'Mock publication failed; retry after selecting successful processing'; row.updatedAt = ctx.now(); }
    else apply(ctx, row);
  }
}
export function handleChanges(ctx: MockContext, pathname: string, method: string, options: MockRequestOptions, path: string): unknown {
  const match = /^\/api\/(me|admin)\/change-requests(?:\/([^/]+)(?:\/(submit|cancel|approve|reject|retry))?)?$/.exec(pathname);
  const projectMatch = /^\/api\/me\/projects\/(\d+)\/change-requests$/.exec(pathname);
  if (!match && !projectMatch) return UNHANDLED;
  const actor = ctx.requireUser();
  if (match?.[1] === 'admin') ctx.requireAdmin();
  if (!match?.[2]) {
    const projectId = projectMatch ? Number(projectMatch[1]) : undefined;
    const project = projectId ? ctx.state.projects[projectId] : undefined;
    if (projectId && !project) missing('Project not found');
    if (project && !staff(ctx) && !related(project, actor.id)) forbidden();
    if (method === 'POST' && project) {
      const input = parseInput(CreateProjectChangeSchema, bodyObject(options));
      if (!related(project, actor.id)) forbidden('Only the creator or linked team members may request changes');
      const exhibition = ctx.state.exhibitions.find(e => e.id === project.exhibitionId);
      if (exhibition?.isModificationEnabled !== false) conflict('This exhibition allows direct changes');
      if (project.status === 'DRAFT' || project.isChangeRequestDraft) conflict('Initial submissions cannot request changes');
      if (Object.values(records(ctx)).some(r => r.projectId === project.id && ['DRAFT', 'PENDING', 'APPLYING', 'FAILED'].includes(r.state))) conflict('This project already has an active change request');
      const row: ChangeRecord = { id: crypto.randomUUID(), projectId: project.id, originalProjectId: project.id, projectTitle: project.title, actorId: actor.id,
        kind: input.kind, state: 'DRAFT', reason: input.reason, reviewReason: null, reviewerId: null, error: null, baseVersion: Number(project.version ?? 1),
        createdAt: ctx.now(), updatedAt: ctx.now(), submittedAt: null, reviewedAt: null, completedAt: null,
        before: { title: project.title, summary: project.summary ?? '', description: project.description ?? '', githubUrl: project.githubUrl ?? '', externalLinks: project.externalLinks ?? [],
          platforms: project.platforms, hardwareRequirements: project.hardwareRequirements ?? '', members: project.members.map(({ name, studentId }) => ({ name, studentId })), posterAssetId: project.posterAssetId ?? null,
          assets: project.assets.map(({ id, kind, originalName }) => ({ id, kind, originalName })), currentWebglDeploymentId: project.webglDeployment?.id ?? null },
        changes: {}, stagingProjectId: null, submissionId: null, items: [], stagedAssets: [] };
      records(ctx)[row.id] = row;
      return detail(ctx, row);
    }
    allowMethod(method, 'GET');
    const query = new URLSearchParams(path.split('?')[1]);
    const all = Object.values(records(ctx)).filter(r => (!projectId || r.originalProjectId === projectId) &&
      (staff(ctx) || r.actorId === actor.id || (source(ctx, r) && related(source(ctx, r)!, actor.id))) && (!query.get('state') || r.state === query.get('state')))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const offset = Math.max(0, Number(query.get('offset') ?? 0)), limit = Math.min(100, Math.max(1, Number(query.get('limit') ?? 50)));
    return { items: all.slice(offset, offset + limit).map(summary), total: all.length };
  }
  const row = records(ctx)[match![2]] ?? missing('Change request not found');
  if (!staff(ctx) && row.actorId !== actor.id && !(source(ctx, row) && related(source(ctx, row)!, actor.id))) forbidden();
  const action = match![3];
  if (!action) {
    allowMethod(method, 'GET', 'PATCH');
    if (method === 'GET') return detail(ctx, row);
    if (match![1] !== 'me') missing();
    if (row.actorId !== actor.id) forbidden('Only the request author may edit a draft');
    if (row.state !== 'DRAFT') conflict('Only a draft request may be edited');
    if (!validSource(ctx, row)) conflict('Project changed or requester no longer has access');
    const input = parseInput(UpdateProjectChangeSchema, bodyObject(options));
    if (row.kind === 'DELETE' && (input.changes || input.manifest)) conflict('A deletion request cannot contain edits');
    if (input.reason !== undefined) row.reason = input.reason;
    if (input.changes) row.changes = input.changes as ProjectChangeValues;
    if (input.manifest) {
      if (new Set(input.manifest.map(i => i.slot)).size !== input.manifest.length || new Set(input.manifest.map(i => i.clientToken)).size !== input.manifest.length) conflict('Manifest slots and client tokens must be unique');
      discardStage(ctx, row); row.stagingProjectId = null; row.submissionId = null; row.items = []; row.stagedAssets = [];
      if (input.manifest.length) {
        const sourceProject = source(ctx, row)!;
        const id = ctx.reserveProjectId();
        const stage: MockProject = { ...structuredClone(sourceProject), id, slug: `change-${row.id}`, status: 'DRAFT', createdByUserId: actor.id,
          members: [], assets: [], videos: [], video: null, isChangeRequestDraft: true, version: 1 };
        delete stage.poster; delete stage.posterAssetId; delete stage.webglUrl; delete stage.webglDeployment;
        const result = createSubmission(ctx, { exhibitionId: Number(sourceProject.exhibitionId), title: sourceProject.title, members: [], manifest: input.manifest.map(i => ({ ...i, required: true })) }, actor.id, { project: stage });
        row.stagingProjectId = result.id; row.submissionId = result.submissionId; row.items = result.items;
      }
    }
    row.updatedAt = ctx.now(); return detail(ctx, row);
  }
  allowMethod(method, 'POST');
  if (['approve', 'reject', 'retry'].includes(action)) { if (match![1] !== 'admin') missing(); ctx.requireAdmin(); }
  else { if (match![1] !== 'me') missing(); if (row.actorId !== actor.id) forbidden('Only the request author may submit or cancel'); }
  if (action === 'submit') {
    if (row.state !== 'DRAFT') conflict('Only a draft request can be submitted');
    if (!validSource(ctx, row)) conflict('Project changed or requester no longer has access');
    ready(ctx, row); row.state = 'PENDING'; row.submittedAt = ctx.now();
  } else if (action === 'cancel' || action === 'reject') {
    if (!(action === 'cancel' ? ['DRAFT', 'PENDING'] : ['PENDING']).includes(row.state)) conflict('Request can no longer be cancelled or rejected');
    if (action === 'reject') { row.reviewReason = parseInput(RejectProjectChangeSchema, bodyObject(options)).reason; row.reviewerId = actor.id; row.reviewedAt = ctx.now(); }
    discardStage(ctx, row); row.state = action === 'cancel' ? 'CANCELLED' : 'REJECTED';
  } else {
    if (action === 'approve' && row.state === 'COMPLETED') return detail(ctx, row);
    if (row.state !== (action === 'retry' ? 'FAILED' : 'PENDING')) conflict('Request is not awaiting this action');
    row.reviewerId = actor.id; row.reviewedAt ??= ctx.now();
    if (!validSource(ctx, row)) { row.state = 'CONFLICT'; row.error = 'Project changed or requester no longer has access'; discardStage(ctx, row); }
    else { ready(ctx, row); if (row.stagingProjectId === null) apply(ctx, row); else { row.state = 'APPLYING'; row.error = null; row.dueAt = Date.now() + 750; } }
  }
  row.updatedAt = ctx.now(); return detail(ctx, row);
}
