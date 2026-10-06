import { SubmitProjectPayloadBaseSchema } from '@pcu/contracts';
import type { DirectAssetUploadKind, DirectAssetUploadStatus, ProjectSubmissionStatusResponse, SubmitProjectPayload, SubmitProjectResponse } from '../../../contracts';
import { MOCK_USERS, MockHttpError, UNHANDLED, type MockContext, type MockProject, type MockRequestOptions } from './context';
import { assertProjectWrite } from './policy';
import { mockFixtureUrl, mockResponsiveImage } from './data';

export type MockSubmissionRecord = ProjectSubmissionStatusResponse & { actorId: number; createdAt: string; finalizedAt?: string };
type UploadedPart = { partNumber: number; etag: string; sizeBytes: number; blockDigests: string[] };
export type MockUploadSession = Omit<DirectAssetUploadStatus, 'parts'> & {
  actorId: number; submissionItemId?: string; completedAt?: string; processingState?: 'PROCESSING' | 'FAILED';
  sourceIdentityBlockDigests: string[]; capabilities: Record<number, { token: string; checksum: string; expiresAt: string }>;
  parts: UploadedPart[]; resultAssetId?: number; previewBlob?: Blob;
};
const fail = (status: number, code: string, message: string): never => { throw new MockHttpError(status, code, message); };
const submissions = (ctx: MockContext) => ctx.state.submissions as Record<string, MockSubmissionRecord>;
const sessions = (ctx: MockContext) => ctx.state.sessions as Record<string, MockUploadSession>;
function json(body: unknown): Record<string, unknown> {
  try { const value = typeof body === 'string' ? JSON.parse(body) : body; if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>; } catch { /* invalid request */ }
  return fail(400, 'VALIDATION_ERROR', 'A JSON object is required');
}
const ms = (ctx: MockContext) => Date.parse(ctx.now());
function assetId(ctx: MockContext): number { return 100000 + Number(ctx.nextId('asset').split('-').pop()); }
function hex(bytes: ArrayBuffer): string { return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join(''); }
async function digest(bytes: ArrayBuffer): Promise<string> { return hex(await crypto.subtle.digest('SHA-256', bytes)); }
async function identityRoot(total: number, digests: string[]): Promise<string> {
  const prefix = new TextEncoder().encode('PCU-UPLOAD-SOURCE-V1\0');
  const bytes = new Uint8Array(prefix.length + 16 + digests.length * 32); bytes.set(prefix);
  const header = new DataView(bytes.buffer, prefix.length, 16); header.setBigUint64(0, BigInt(total)); header.setUint32(8, 1048576); header.setUint32(12, digests.length);
  digests.forEach((value, index) => bytes.set(value.match(/../g)!.map(byte => parseInt(byte, 16)), prefix.length + 16 + index * 32));
  return digest(bytes.buffer);
}
function assertManifest(payload: SubmitProjectPayload): void {
  const slots = new Set<string>(); const tokens = new Set<string>();
  for (const item of payload.manifest) {
    const slot = item.kind === 'GAME' || item.kind === 'WEBGL' || item.kind === 'POSTER' ? item.kind.toLowerCase() : `${item.kind.toLowerCase()}:`;
    if ((slot.endsWith(':') ? !item.slot.startsWith(slot) : item.slot !== slot) || slots.has(item.slot) || tokens.has(item.clientToken)) fail(400, 'VALIDATION_ERROR', 'Manifest kind, slot and client token must match uniquely');
    slots.add(item.slot); tokens.add(item.clientToken);
  }
  const videos = payload.manifest.filter(item => item.kind === 'VIDEO');
  if (videos.length > 5 || videos.some((_, index) => !slots.has(`video:${index}`)) || payload.manifest.filter(item => ['DOCUMENT', 'ATTACHMENT'].includes(item.kind)).length > 5) fail(400, 'VALIDATION_ERROR', 'Too many or nonconsecutive manifest items');
}
export function createSubmission(ctx: MockContext, payload: SubmitProjectPayload, actorId: number, options: { project?: MockProject } = {}): SubmitProjectResponse {
  assertManifest(payload);
  const exhibition = ctx.state.exhibitions.find(item => item.id === payload.exhibitionId) ?? fail(404, 'NOT_FOUND', 'Exhibition not found');
  let project = options.project;
  if (!project) {
    const id = Math.max(10000, ...Object.keys(ctx.state.projects).map(Number)) + 1;
    const slugBase = payload.title.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '') || 'project';
    let slug = slugBase; let suffix = 1;
    while (Object.values(ctx.state.projects).some(item => item.exhibitionId === exhibition.id && item.slug === slug)) slug = `${slugBase}-${++suffix}`;
    project = { id, exhibitionId: exhibition.id, title: payload.title, slug, year: exhibition.year, status: 'DRAFT', visibility: payload.visibility ?? 'PUBLIC', exhibitionVisibility: exhibition.visibility,
      canChangeVisibility: true, platforms: [], isIncomplete: false, sortOrder: 0, summary: payload.summary ?? '', description: payload.description ?? '', externalLinks: payload.externalLinks ?? [],
      video: null, videos: [], assets: [], members: payload.members.map((member, index) => ({ ...member, id: assetId(ctx), sortOrder: member.sortOrder ?? index, userId: member.userId ?? Object.values(MOCK_USERS).find(user => user.studentId === member.studentId)?.id ?? null })),
      version: 1, webglNetworkPolicyVersion: 1, createdByUserId: actorId, createdAt: ctx.now(), updatedAt: ctx.now() };
  }
  ctx.state.projects[project.id] = project;
  const submission: MockSubmissionRecord = { submissionId: crypto.randomUUID(), projectId: project.id, projectStatus: 'DRAFT', state: 'PENDING', actorId, createdAt: ctx.now(),
    items: payload.manifest.map(item => ({ ...item, id: crypto.randomUUID(), state: 'EXPECTED' })) };
  submissions(ctx)[project.id] = submission;
  return { id: project.id, slug: project.slug, year: project.year, status: 'DRAFT', submissionId: submission.submissionId, items: submission.items, adminEditUrl: mockFixtureUrl(`/admin/projects/${project.id}/edit`) };
}
function boundItem(ctx: MockContext, session: MockUploadSession) { return session.owner.type === 'PROJECT' ? submissions(ctx)[session.owner.id]?.items.find(item => item.id === session.submissionItemId && item.sessionId === session.sessionId) : undefined; }
function ownedUrl(url: string, owner: MockUploadSession['owner']): string { const target = new URL(url); target.searchParams.set(owner.type === 'PROJECT' ? 'mock_project' : 'mock_exhibition', String(owner.id)); return target.href; }
function ownedImage(owner: MockUploadSession['owner']) { const image = mockResponsiveImage('/mock/images/1200x675.png'); image.original.url = ownedUrl(image.original.url, owner); image.renditions = image.renditions.map(rendition => ({ ...rendition, url: ownedUrl(rendition.url, owner) })); return image; }
function attachAsset(ctx: MockContext, session: MockUploadSession, ready: boolean): void {
  if (session.owner.type === 'EXHIBITION') {
    if (ready) { const exhibition = ctx.state.exhibitions.find(item => item.id === session.owner.id); if (exhibition) Object.assign(exhibition, { poster: ownedImage(session.owner), posterOriginalName: session.originalName, posterSize: session.totalBytes }); }
    return;
  }
  const project = ctx.state.projects[session.owner.id]; if (!project) return;
  const id = session.resultAssetId ??= assetId(ctx); const url = ownedUrl(mockFixtureUrl(session.kind === 'GAME' ? '/mock/files/game.zip' : session.kind === 'VIDEO' ? '/mock/files/demo.webm' : '/mock/files/readme.txt'), session.owner);
  project.assets = project.assets.filter(asset => asset.id !== id && !(['GAME', 'POSTER'].includes(session.kind) && asset.kind === session.kind));
  if (session.kind === 'WEBGL') { if (ready) { project.webglUrl = ownedUrl(mockFixtureUrl('/mock/webgl/index.html'), session.owner); project.webglDeployment = { id: session.sessionId, url: project.webglUrl, createdAt: ctx.now() }; } return; }
  if (session.kind === 'IMAGE' || session.kind === 'POSTER') {
    const image = ownedImage(session.owner); project.assets.push({ id, kind: session.kind, image, originalName: session.originalName, size: session.totalBytes });
    if (session.kind === 'POSTER') { project.posterAssetId = id; project.poster = image; }
  } else if (session.kind === 'DOCUMENT' || session.kind === 'ATTACHMENT') {
    project.assets.push({ id, kind: session.kind, originalName: session.originalName, size: session.totalBytes, mimeType: session.kind === 'DOCUMENT' ? 'application/pdf' : 'application/octet-stream', downloadUrl: url });
  } else {
    project.assets.push({ id, kind: session.kind, originalName: session.originalName, size: session.totalBytes, url, ...(session.kind === 'VIDEO' ? { videoSortOrder: Number(boundItem(ctx, session)?.slot.split(':')[1] ?? project.assets.filter(asset => asset.kind === 'VIDEO').length), playbackStatus: ready ? 'READY' as const : 'PENDING' as const, ...(ready ? { playbackUrl: url } : {}) } : {}) });
  }
  project.videos = project.assets.flatMap((asset) => asset.kind === 'VIDEO' && 'url' in asset ? [{ assetId: asset.id, sortOrder: asset.videoSortOrder ?? 0, role: 'MAIN' as const, mimeType: 'video/webm', ...(asset.playbackStatus === 'READY' ? { url: asset.playbackUrl ?? asset.url } : {}), originalDownloadUrl: asset.url, playbackStatus: asset.playbackStatus ?? 'PENDING' }] : []).sort((a, b) => a.sortOrder - b.sortOrder).map((video, index) => ({ ...video, sortOrder: index, role: index === 0 ? 'MAIN' : 'ADDITIONAL' }));
  project.video = project.videos[0] ?? null;
  project.attachments = project.assets.flatMap(asset => (asset.kind === 'DOCUMENT' || asset.kind === 'ATTACHMENT') && 'downloadUrl' in asset ? [{ assetId: asset.id, kind: asset.kind, originalName: asset.originalName, sizeBytes: asset.size, mimeType: asset.mimeType, downloadUrl: asset.downloadUrl }] : []);
  project.updatedAt = ctx.now();
}
export function advanceUploadJobs(ctx: MockContext): void {
  for (const session of Object.values(sessions(ctx))) {
    const item = boundItem(ctx, session);
    if (session.state === 'UPLOADING' && Date.parse(session.expiresAt) <= ms(ctx)) { session.state = 'EXPIRED'; if (item) { item.state = 'FAILED'; item.failureReason = 'Upload expired'; } }
    if (session.state !== 'VERIFYING' || !session.completedAt || ctx.state.controls.worker === 'paused') continue;
    const elapsed = ms(ctx) - Date.parse(session.completedAt);
    if (elapsed < 300) continue;
    if (ctx.state.controls.worker === 'fail' || session.processingState === 'FAILED') {
      session.state = 'REJECTED'; session.processingState = 'FAILED';
      if (session.kind === 'VIDEO' && session.owner.type === 'PROJECT') { const project = ctx.state.projects[session.owner.id]; if (project) { const asset = project.assets.find(candidate => candidate.id === session.resultAssetId); if (asset && 'playbackStatus' in asset) { asset.playbackStatus = 'FAILED'; asset.playbackError = 'Mock video processing failed'; } project.videos.forEach(video => { if (video.assetId === session.resultAssetId) { video.playbackStatus = 'FAILED'; video.playbackError = 'Mock video processing failed'; } }); project.video = project.videos[0] ?? null; } }
      if (item) { item.state = 'FAILED'; item.failureReason = 'Mock asset processing failed'; if (session.kind === 'VIDEO') { item.playbackState = 'FAILED'; item.playbackError = 'Mock video processing failed'; } } continue;
    }
    if (elapsed < 900) { session.processingState = 'PROCESSING'; if (session.kind === 'VIDEO') attachAsset(ctx, session, false); continue; }
    session.state = 'READY'; delete session.processingState; attachAsset(ctx, session, true); if (item) { item.state = 'READY'; delete item.failureReason; if (session.kind === 'VIDEO') item.playbackState = 'READY'; }
  }
  for (const submission of Object.values(submissions(ctx))) {
    if (submission.state !== 'FINALIZING' || submission.publicationState === 'FAILED' || !submission.finalizedAt || ctx.state.controls.worker === 'paused' || ms(ctx) - Date.parse(submission.finalizedAt) < 600) continue;
    if (ctx.state.controls.worker === 'fail') { submission.publicationState = 'FAILED'; submission.publicationError = 'Mock publication failed'; continue; }
    submission.state = 'PUBLISHED'; submission.publicationState = 'COMPLETED'; delete submission.publicationError;
    const project = ctx.state.projects[submission.projectId]; if (project && !project.isChangeRequestDraft) { project.status = 'PUBLISHED'; project.updatedAt = ctx.now(); submission.projectStatus = 'PUBLISHED'; }
  }
}
function assertProjectUpload(ctx: MockContext, project: MockProject): void {
  if (!project.isChangeRequestDraft) { assertProjectWrite(ctx, project); return; }
  const request = Object.values(ctx.state.changeRequests).find(value => { const row = value as { stagingProjectId?: number }; return row.stagingProjectId === project.id; }) as { actorId: number; state: string; projectId: number | null } | undefined;
  if (!request || request.actorId !== ctx.requireUser().id || request.state !== 'DRAFT') return fail(403, 'FORBIDDEN', 'Staged upload belongs to another or closed request');
  const source = request.projectId === null ? undefined : ctx.state.projects[request.projectId];
  if (!source || (source.createdByUserId !== request.actorId && !source.members.some(member => member.userId === request.actorId))) fail(403, 'FORBIDDEN', 'Request source is no longer accessible');
}
function authorizeOwner(ctx: MockContext, owner: MockUploadSession['owner']): void {
  ctx.requireUser();
  if (owner.type === 'EXHIBITION') { ctx.requireAdmin(); if (!ctx.state.exhibitions.some(item => item.id === owner.id)) fail(404, 'NOT_FOUND', 'Exhibition not found'); }
  else { const project = ctx.state.projects[owner.id] ?? fail(404, 'NOT_FOUND', 'Project not found'); assertProjectUpload(ctx, project); }
}
function submissionStatus(submission: MockSubmissionRecord): ProjectSubmissionStatusResponse {
  return { submissionId: submission.submissionId, projectId: submission.projectId, projectStatus: submission.projectStatus,
    state: submission.state, items: submission.items,
    ...(submission.publicationState ? { publicationState: submission.publicationState } : {}),
    ...(submission.publicationError ? { publicationError: submission.publicationError } : {}) };
}
function sessionStatus(session: MockUploadSession): DirectAssetUploadStatus {
  return { sessionId: session.sessionId, owner: session.owner, kind: session.kind, state: session.state, generation: session.generation,
    ...(session.owner.type === 'PROJECT' ? { projectId: session.owner.id } : { exhibitionId: session.owner.id }),
    originalName: session.originalName, totalBytes: session.totalBytes, partSizeBytes: session.partSizeBytes, totalParts: session.totalParts,
    expiresAt: session.expiresAt, sourceIdentityAlgorithm: session.sourceIdentityAlgorithm, sourceIdentity: session.sourceIdentity,
    parts: session.parts.map(({ partNumber, etag, sizeBytes }) => ({ partNumber, etag, sizeBytes })) };
}
function createdSession(session: MockUploadSession) {
  return { sessionId: session.sessionId, owner: session.owner, generation: session.generation, partSizeBytes: session.partSizeBytes,
    totalParts: session.totalParts, expiresAt: session.expiresAt, sourceIdentityAlgorithm: session.sourceIdentityAlgorithm,
    sourceIdentity: session.sourceIdentity, sourceIdentityBlockSizeBytes: 1048576 as const };
}
function assertUploading(ctx: MockContext, session: MockUploadSession, generation?: unknown): void {
  if (generation !== undefined && generation !== session.generation) fail(409, 'CONFLICT', 'Stale upload generation');
  if (session.state !== 'UPLOADING' || Date.parse(session.expiresAt) <= ms(ctx)) fail(409, 'CONFLICT', `Upload is ${session.state.toLowerCase()}`);
}
export async function handleUploads(ctx: MockContext, pathname: string, method: string, options: MockRequestOptions, originalPath: string): Promise<unknown> {
  advanceUploadJobs(ctx);
  let match = pathname.match(/^\/api\/(admin|me)\/projects\/submit$/);
  if (match) {
    const actor = match[1] === 'admin' ? ctx.requireAdmin() : ctx.requireUser(); if (method !== 'POST') return fail(404, 'NOT_FOUND', 'Use POST');
    if (!(options.body instanceof FormData)) return fail(400, 'VALIDATION_ERROR', 'Multipart payload is required');
    for (const [field, value] of options.body.entries()) if (field !== 'payload' || typeof value !== 'string') fail(400, 'VALIDATION_ERROR', 'File fields must use direct upload sessions');
    const raw = json(options.body.get('payload'));
    if (match[1] === 'me') {
      const forbidden = ['status', 'sortOrder', 'isIncomplete', 'creator', 'creatorId', 'creatorUserId', 'createdBy', 'createdByUserId', 'createdByUserName', 'posterAssetId', 'assetIds', 'ids', 'bulkStatus', 'bulkDelete'];
      if (forbidden.some(key => key in raw) || (Array.isArray(raw.members) && raw.members.some(member => member && typeof member === 'object' && ('userId' in member || 'sortOrder' in member)))) fail(400, 'USER_SUBMIT_FORBIDDEN_FIELD', 'Submission contains a restricted field');
    }
    const parsed = SubmitProjectPayloadBaseSchema.safeParse(raw); if (!parsed.success) return fail(400, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid submission');
    const payload = parsed.data as SubmitProjectPayload;
    const exhibition = ctx.state.exhibitions.find(item => item.id === payload.exhibitionId) ?? fail(404, 'NOT_FOUND', 'Exhibition not found');
    if (exhibition.visibility === 'STAFF' && actor.role === 'USER') fail(403, 'FORBIDDEN', 'Exhibition is private');
    if (match[1] === 'me' && !(exhibition.isModificationEnabled ?? exhibition.isUploadEnabled)) fail(403, 'FORBIDDEN', 'Submissions are closed');
    const key = new Headers(options.headers).get('idempotency-key'); const identity = `${actor.id}:project-submit:${match[1]}:${key}`;
    if (key && !/^[A-Za-z0-9_-]{8,128}$/.test(key)) fail(400, 'VALIDATION_ERROR', 'Invalid idempotency key');
    const requestHash = JSON.stringify(raw); const previous = ctx.state.idempotency[identity] as { hash: string; result: SubmitProjectResponse } | undefined;
    if (key && previous) { if (previous.hash !== requestHash) fail(409, 'CONFLICT', 'Idempotency key was used for another payload'); return previous.result; }
    const result = createSubmission(ctx, payload, actor.id); if (key) ctx.state.idempotency[identity] = { hash: requestHash, result: JSON.parse(JSON.stringify(result)) }; return result;
  }
  match = pathname.match(/^\/api\/(admin|me)\/projects\/(\d+)\/submission(?:\/(finalize))?$/);
  if (match) {
    const actor = match[1] === 'admin' ? ctx.requireAdmin() : ctx.requireUser();
    const submission = submissions(ctx)[match[2]!] ?? fail(method === 'GET' ? 400 : 404, method === 'GET' ? 'ERROR' : 'NOT_FOUND', 'Project submission not found');
    if (actor.role === 'USER' && submission.actorId !== actor.id) fail(403, 'FORBIDDEN', 'Submission belongs to another user');
    if (!match[3] && method === 'DELETE') {
      if (submission.state === 'PUBLISHED') fail(409, 'CONFLICT', 'Published submission cannot be cancelled');
      submission.state = 'CANCELLED'; submission.publicationState = 'CANCELLED';
      for (const item of submission.items) { item.state = 'CANCELLED'; const session = item.sessionId && sessions(ctx)[item.sessionId]; if (session) session.state = 'CANCELLED'; }
      return submissionStatus(submission);
    }
    if (match[3] && method === 'POST') {
      if (submission.state === 'CANCELLED') fail(409, 'CONFLICT', 'Submission is cancelled');
      if (submission.state === 'PUBLISHED') return submissionStatus(submission);
      if (!submission.items.every(item => item.state === 'READY')) fail(409, 'CONFLICT', 'Submission assets are not ready');
      if (submission.state !== 'FINALIZING' || submission.publicationState === 'FAILED') { submission.state = 'FINALIZING'; submission.publicationState = 'PROCESSING'; submission.finalizedAt = ctx.now(); delete submission.publicationError; }
      return submissionStatus(submission);
    }
    if (!match[3] && method === 'GET') return submissionStatus(submission);
    return fail(404, 'NOT_FOUND', 'Unsupported submission method');
  }
  match = pathname.match(/^\/api\/admin\/(projects|exhibitions)\/(\d+)\/direct-(game|webgl|video|image|poster|document|attachment)-upload-sessions$/);
  if (match) {
    if (method !== 'POST') return fail(404, 'NOT_FOUND', 'Use POST');
    const owner = { type: match[1] === 'projects' ? 'PROJECT' as const : 'EXHIBITION' as const, id: Number(match[2]) }; const kind = match[3]!.toUpperCase() as DirectAssetUploadKind;
    authorizeOwner(ctx, owner); if (owner.type === 'EXHIBITION' && kind !== 'POSTER') fail(404, 'NOT_FOUND', 'Only exhibition posters are supported');
    const body = json(options.body); const total = Number(body.totalBytes);
    const maxBytes = ['DOCUMENT', 'ATTACHMENT'].includes(kind) ? 50 * 1024 * 1024 : ctx.state.settings.maxGameFileMb * 1024 * 1024;
    if (!Number.isSafeInteger(total) || total < 1 || total > maxBytes || typeof body.originalName !== 'string' || !body.originalName || Array.from(body.originalName).some(character => character === '/' || character === '\\' || character.charCodeAt(0) < 32)) fail(400, 'VALIDATION_ERROR', 'Invalid file name or size');
    const digests = body.sourceIdentityBlockDigests;
    if (body.sourceIdentityAlgorithm !== 'SHA256_BLOCK_MANIFEST_V1' || body.sourceIdentityBlockSizeBytes !== 1048576 || !Array.isArray(digests) || digests.length !== Math.ceil(total / 1048576) || digests.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) || await identityRoot(total, digests) !== body.sourceIdentity) fail(400, 'VALIDATION_ERROR', 'Invalid source identity');
    let item: MockSubmissionRecord['items'][number] | undefined;
    if (owner.type === 'PROJECT') {
      const project = ctx.state.projects[owner.id]!; const submission = submissions(ctx)[owner.id];
      if (project.status === 'DRAFT') {
        const binding = body.submissionItem as { id?: string; clientToken?: string } | undefined;
        item = submission?.items.find(candidate => candidate.id === binding?.id);
        if (!submission || submission.actorId !== ctx.requireUser().id || submission.state !== 'PENDING' || !item || item.kind !== kind || item.clientToken !== binding?.clientToken || !['EXPECTED', 'FAILED', 'CANCELLED'].includes(item.state)) fail(409, 'CONFLICT', 'Upload does not match an available submission item');
      } else {
        if (body.submissionItem) fail(409, 'CONFLICT', 'Published project uploads cannot bind a submission item');
        if (kind === 'VIDEO' && project.assets.filter(asset => asset.kind === 'VIDEO').length >= 5) fail(409, 'CONFLICT', 'A project supports at most five videos');
        if (['DOCUMENT', 'ATTACHMENT'].includes(kind) && project.assets.filter(asset => ['DOCUMENT', 'ATTACHMENT'].includes(asset.kind)).length >= 5) fail(409, 'CONFLICT', 'A project supports at most five materials');
      }
    } else if (body.submissionItem) fail(409, 'CONFLICT', 'Exhibition uploads cannot bind a submission item');
    const session: MockUploadSession = { sessionId: crypto.randomUUID(), owner, kind, actorId: ctx.requireUser().id, generation: 1, state: 'UPLOADING', originalName: body.originalName as string, totalBytes: total, partSizeBytes: 5 * 1024 * 1024, totalParts: Math.ceil(total / (5 * 1024 * 1024)), expiresAt: new Date(ms(ctx) + 3600000).toISOString(), sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: body.sourceIdentity as string, sourceIdentityBlockDigests: digests as string[], capabilities: {}, parts: [], ...(item ? { submissionItemId: item.id } : {}) };
    sessions(ctx)[session.sessionId] = session;
    if (item) { if (item.sessionId) { const old = sessions(ctx)[item.sessionId]; if (old) { delete old.submissionItemId; if (old.resultAssetId && owner.type === 'PROJECT') { const project = ctx.state.projects[owner.id]!; project.assets = project.assets.filter(asset => asset.id !== old.resultAssetId); project.videos = project.videos.filter(video => video.assetId !== old.resultAssetId); project.video = project.videos[0] ?? null; } } } item.state = 'UPLOADING'; item.sessionId = session.sessionId; item.generation = session.generation; delete item.failureReason; delete item.playbackState; delete item.playbackError; }
    return Response.json({ ok: true, data: createdSession(session) }, { status: 201 });
  }
  match = pathname.match(/^\/mock\/garage-upload\/([^/]+)\/(\d+)\/([^/]+)$/);
  if (match) {
    if (method !== 'PUT') return fail(404, 'NOT_FOUND', 'Use PUT');
    const session = sessions(ctx)[match[1]!] ?? fail(404, 'NOT_FOUND', 'Session not found'); assertUploading(ctx, session);
    const number = Number(match[2]); const capability = session.capabilities[number];
    if (!capability || capability.token !== match[3] || Date.parse(capability.expiresAt) <= ms(ctx)) fail(403, 'FORBIDDEN', 'Upload capability is invalid or expired');
    if (!(options.body instanceof Blob)) fail(400, 'VALIDATION_ERROR', 'Upload body must be a Blob');
    const body = options.body as Blob; const expectedSize = Math.min(session.partSizeBytes, session.totalBytes - (number - 1) * session.partSizeBytes);
    if (body.size !== expectedSize) fail(400, 'SIZE_MISMATCH', 'Part size does not match');
    const bytes = await body.arrayBuffer(); const actualDigest = await digest(bytes); const checksum = btoa(String.fromCharCode(...actualDigest.match(/../g)!.map(value => parseInt(value, 16))));
    if (checksum !== capability.checksum || new Headers(options.headers).get('x-amz-checksum-sha256') !== capability.checksum) fail(400, 'VALIDATION_ERROR', 'Part checksum does not match');
    const blockDigests: string[] = []; for (let offset = 0; offset < bytes.byteLength; offset += 1048576) blockDigests.push(await digest(bytes.slice(offset, offset + 1048576)));
    if (session.totalBytes <= 1024 * 1024 && ['IMAGE','POSTER','VIDEO','DOCUMENT','ATTACHMENT'].includes(session.kind)) session.previewBlob = body;
    const etag = `"mock-${actualDigest.slice(0, 32)}"`; session.parts = session.parts.filter(part => part.partNumber !== number); session.parts.push({ partNumber: number, etag, sizeBytes: body.size, blockDigests }); session.parts.sort((a, b) => a.partNumber - b.partNumber);
    return new Response(null, { status: 200, headers: { ETag: etag } });
  }
  match = pathname.match(/^\/api\/admin\/direct-asset-upload-sessions\/([^/]+)(?:\/(part-urls|complete))?$/);
  if (match) {
    const session = sessions(ctx)[match[1]!] ?? fail(404, 'NOT_FOUND', 'Upload session not found'); authorizeOwner(ctx, session.owner);
    if (!match[2] && method === 'GET') return sessionStatus(session);
    if (!match[2] && method === 'DELETE') { if (session.state === 'READY') fail(409, 'CONFLICT', 'Ready upload cannot be cancelled'); session.state = 'CANCELLED'; const item = boundItem(ctx, session); if (item) item.state = 'CANCELLED'; return undefined; }
    if (method !== 'POST') fail(404, 'NOT_FOUND', 'Unsupported upload method'); const body = json(options.body);
    if (match[2] === 'part-urls') {
      assertUploading(ctx, session, body.generation); const parts = body.parts as Array<{ partNumber: number; checksumSha256: string }>;
      if (!Array.isArray(parts) || parts.length < 1 || parts.length > 32 || new Set(parts.map(part => part?.partNumber)).size !== parts.length || parts.some(part => !part || !Number.isInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > session.totalParts || !/^[A-Za-z0-9+/]{43}=$/.test(part.checksumSha256))) fail(400, 'VALIDATION_ERROR', 'Invalid part capability manifest');
      const expiresAt = new Date(Math.min(ms(ctx) + 300000, Date.parse(session.expiresAt))).toISOString();
      return { generation: session.generation, expiresAt, parts: parts.map(part => { const token = crypto.randomUUID(); session.capabilities[part.partNumber] = { token, checksum: part.checksumSha256, expiresAt }; return { partNumber: part.partNumber, url: mockFixtureUrl(`/mock/garage-upload/${session.sessionId}/${part.partNumber}/${token}`), requiredHeaders: { 'x-amz-checksum-sha256': part.checksumSha256 } }; }) };
    }
    if (match[2] === 'complete') {
      if (body.generation !== session.generation) fail(409, 'CONFLICT', 'Stale upload generation');
      if (['VERIFYING', 'READY'].includes(session.state)) return { status: session.state, sessionId: session.sessionId, generation: session.generation, sizeBytes: session.totalBytes };
      assertUploading(ctx, session, body.generation); const parts = body.parts as Array<{ partNumber: number; etag: string; sizeBytes: number }>;
      if (!Array.isArray(parts) || parts.length !== session.totalParts || session.parts.length !== session.totalParts || parts.some((part, index) => !part || part.partNumber !== index + 1 || part.etag?.trim() !== session.parts[index]?.etag || part.sizeBytes !== session.parts[index]?.sizeBytes)) fail(409, 'CONFLICT', 'Completion manifest does not match uploaded parts');
      if (JSON.stringify(session.parts.flatMap(part => part.blockDigests)) !== JSON.stringify(session.sourceIdentityBlockDigests)) session.processingState = 'FAILED';
      session.state = 'VERIFYING'; session.completedAt = ctx.now(); const item = boundItem(ctx, session); if (item) item.state = 'VERIFYING'; return { status: 'VERIFYING', sessionId: session.sessionId, generation: session.generation, sizeBytes: session.totalBytes };
    }
  }
  void originalPath;
  return UNHANDLED;
}
