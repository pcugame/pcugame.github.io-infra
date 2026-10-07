import { normalizeIpTarget, VisibilitySchema, type ExportProgress, type ExportStatusResponse, type ExportResult, type ImportPreviewResult } from '@pcu/contracts';
import { z } from 'zod';
import { UNHANDLED, type MockContext, type MockRequestOptions, type MockProject } from './context';
import { allowMethod, bodyObject, conflict, missing, parseInput } from './common';

const ImportMember = z.object({ name: z.string().min(1).max(50), studentId: z.string().max(20).optional().default(''), sortOrder: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() });
const ImportProject = z.object({ visibility: VisibilitySchema.default('PUBLIC'), year: z.number().int().min(2000).max(2100), title: z.string().min(1).max(120), slug: z.string().max(80).optional(),
  summary: z.string().max(300).default(''), description: z.string().max(5000).default(''), isIncomplete: z.boolean().default(false), status: z.enum(['PUBLISHED','ARCHIVED']).default('PUBLISHED'),
  githubUrl: z.string().max(500).default(''), platforms: z.array(z.enum(['PC','MOBILE','WEB'])).default([]), members: z.array(ImportMember).default([]) });
const ImportYear = z.object({ visibility: VisibilitySchema.default('PUBLIC'), year: z.number().int().min(2000).max(2100), title: z.string().max(100).default(''),
  isModificationEnabled: z.boolean().optional(), isUploadEnabled: z.boolean().optional() }).refine(v => v.isModificationEnabled === undefined || v.isUploadEnabled === undefined || v.isModificationEnabled === v.isUploadEnabled, 'Modification flags disagree');
const ImportData = z.object({ years: z.array(ImportYear).default([]), projects: z.array(ImportProject).default([]) });
type ExportJob = { id: string; state: 'QUEUED'|'RUNNING'|'READY'|'FAILED'; createdAt: number; dueAt: number; progress: ExportProgress; result: ExportResult|null; error: string|null };
function jobs(ctx: MockContext) { return ctx.state.exportJobs as Record<string, ExportJob>; }
export function advanceExportJobs(ctx: MockContext) {
  if (ctx.state.controls.worker === 'paused') return;
  for (const job of Object.values(jobs(ctx))) {
    if (!['QUEUED','RUNNING'].includes(job.state)) continue;
    if (Date.now() >= job.dueAt) {
      if (ctx.state.controls.worker === 'fail') { job.state = 'FAILED'; job.error = 'Mock export failed'; }
      else { job.state = 'READY'; job.progress.downloaded = job.progress.totalFiles; job.progress.phase = 'finishing'; job.progress.currentProjectIndex = job.progress.totalProjects;
        job.result = { projects: job.progress.totalProjects, totalFiles: job.progress.totalFiles, downloaded: job.progress.totalFiles, skipped: 0, failed: 0, aborted: false, paths: [`mock/ExportedAssets/${job.id}/manifest.json`] }; }
    } else if (Date.now() >= job.createdAt + 250) { job.state = 'RUNNING'; job.progress.phase = 'downloading'; }
  }
}
async function fileText(options: MockRequestOptions) {
  if (!(options.body instanceof FormData)) throw new Error('A multipart JSON file is required');
  const file = options.body.get('file');
  if (!(file instanceof Blob)) throw new Error('A JSON file is required');
  if (file.size > 10 * 1024 * 1024) throw new Error('Import file is too large');
  if (typeof file.text === 'function') return file.text();
  return await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(file); });
}
export async function handleManagement(ctx: MockContext, pathname: string, method: string, options: MockRequestOptions): Promise<unknown> {
  if (!/^\/api\/admin\/(settings|banned-ips|import|export)(\/|$)/.test(pathname)) return UNHANDLED;
  const actor = ctx.requireAdmin();
  if (pathname === '/api/admin/settings') {
    allowMethod(method, 'GET','PATCH');
    if (method === 'PATCH') {
      const body = bodyObject(options), patch: Partial<typeof ctx.state.settings> = {};
      if (body.maxGameFileMb !== undefined) patch.maxGameFileMb = parseInput(z.coerce.number().int().min(1), body.maxGameFileMb);
      if (body.maxChunkSizeMb !== undefined) patch.maxChunkSizeMb = parseInput(z.coerce.number().int().min(5).max(10), body.maxChunkSizeMb);
      if (!Object.keys(patch).length) parseInput(z.never(), body);
      Object.assign(ctx.state.settings, patch);
    }
    return ctx.state.settings;
  }
  if (pathname === '/api/admin/banned-ips') {
    allowMethod(method,'GET','POST');
    if (method === 'GET') return { items: ctx.state.bannedIps };
    const body = parseInput(z.object({ ip: z.string(), reason: z.string().trim().min(1).max(1000) }), bodyObject(options));
    let ip: string; try { ip = normalizeIpTarget(body.ip); } catch { return parseInput(z.never(), 'Invalid IP address or CIDR'); }
    if (ctx.state.bannedIps.some(item => item.ip === ip && item.active)) conflict('This IP address or range is already blocked');
    const existing = ctx.state.bannedIps.find(item => item.ip === ip);
    if (existing) { existing.active = true; existing.disabledAt = null; existing.reason = body.reason; existing.source = 'MANUAL'; return existing; }
    const item = { id: Math.max(0,...ctx.state.bannedIps.map(b => b.id)) + 1, ip, reason: body.reason, createdAt: ctx.now(), source: 'MANUAL' as const, active: true, disabledAt: null };
    ctx.state.bannedIps.unshift(item); return item;
  }
  const ban = /^\/api\/admin\/banned-ips\/(\d+)$/.exec(pathname);
  if (ban) { allowMethod(method,'DELETE'); const item = ctx.state.bannedIps.find(b => b.id === Number(ban[1])) ?? missing(); item.active = false; item.disabledAt = ctx.now(); return undefined; }
  if (/^\/api\/admin\/(import|export)(\/|$)/.test(pathname) && actor.role !== 'ADMIN') throw new (await import('./context')).MockHttpError(403,'FORBIDDEN','ADMIN role required');
  if (pathname === '/api/admin/import/preview' || pathname === '/api/admin/import/execute') {
    allowMethod(method,'POST');
    let raw: unknown, errors: string[] = [];
    try { raw = JSON.parse(await fileText(options)); } catch (error) { errors = [error instanceof Error ? error.message : 'Invalid JSON']; }
    const parsed = ImportData.safeParse(raw);
    if (!parsed.success && !errors.length) errors = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
    if (!parsed.success || errors.length) {
      if (pathname.endsWith('preview')) return { valid: false, exhibitions: [], projectCount: 0, errors };
      return parseInput(ImportData, raw);
    }
    const data = parsed.data;
    const exhibitionInputs = [...data.years.map(y => ({ ...y, title: y.title || `${y.year} 졸업작품전` }))];
    for (const p of data.projects) if (!exhibitionInputs.some(e => e.year === p.year)) exhibitionInputs.push({ year: p.year, title: `${p.year} 졸업작품전`, visibility: 'PUBLIC' });
    if (pathname.endsWith('preview')) {
      const preview: ImportPreviewResult = { valid: true, exhibitions: exhibitionInputs.map(e => {
        const existing = ctx.state.exhibitions.find(x => x.year === e.year && x.title === e.title);
        return { year: e.year, title: e.title, isNew: !existing, existingProjectCount: existing ? Object.values(ctx.state.projects).filter(p => p.exhibitionId === existing.id && !p.isChangeRequestDraft).length : 0 };
      }), projectCount: data.projects.length, errors: [] }; return preview;
    }
    let created = 0, existing = 0;
    const exhibitionByYear = new Map<number, number>();
    for (const e of exhibitionInputs) {
      let exhibition = ctx.state.exhibitions.find(x => x.year === e.year && x.title === e.title);
      if (exhibition) existing++;
      else { created++; const modification = e.isModificationEnabled ?? e.isUploadEnabled ?? true;
        exhibition = { id: Math.max(0,...ctx.state.exhibitions.map(x=>x.id))+1, year: e.year, title: e.title, visibility: e.visibility,
          isModificationEnabled: modification, isUploadEnabled: modification, projectCount: 0, sortOrder: ctx.state.exhibitions.length }; ctx.state.exhibitions.push(exhibition); }
      if (!exhibitionByYear.has(e.year)) exhibitionByYear.set(e.year, exhibition.id);
    }
    for (const p of data.projects) {
      const id = Math.max(0,...Object.keys(ctx.state.projects).map(Number)) + 1;
      const exhibitionId = exhibitionByYear.get(p.year)!;
      const base = p.slug || p.title.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-|-$/g,'') || 'project';
      let slug = base, suffix = 0; while (Object.values(ctx.state.projects).some(x => x.exhibitionId === exhibitionId && x.slug === slug)) slug = `${base}-${++suffix}`;
      const project: MockProject = { ...p, id, slug, exhibitionId, createdByUserId: actor.id, version: 1, webglNetworkPolicyVersion: 0,
        createdAt: ctx.now(), updatedAt: ctx.now(), canChangeVisibility: true, exhibitionVisibility: ctx.state.exhibitions.find(e=>e.id===exhibitionId)!.visibility,
        members: p.members.map((m,index)=>({...m,id:id*100+index,sortOrder:m.sortOrder??index,userId:null})), sortOrder: 0, assets: [], video: null, videos: [], attachments: [] };
      ctx.state.projects[id] = project;
    }
    return { exhibitions: { created, existing }, projects: { created: data.projects.length } };
  }
  if (pathname === '/api/admin/export') {
    allowMethod(method,'POST'); const body = bodyObject(options);
    const year = body.year === undefined ? null : parseInput(z.number().int().min(2000).max(2100), body.year);
    if (Object.values(jobs(ctx)).some(j=>['QUEUED','RUNNING'].includes(j.state))) conflict('An export is already running');
    const projects = Object.values(ctx.state.projects).filter(p => !p.isChangeRequestDraft && (!year || p.year === year));
    const id = crypto.randomUUID();
    const job: ExportJob = { id, state: 'QUEUED', createdAt: Date.now(), dueAt: Date.now() + 1200, error: null, result: null,
      progress: { year, startedAt: Date.now(), phase:'preparing', totalProjects:projects.length, currentProjectIndex:0, currentProjectTitle:null, currentProjectFiles:[], totalFiles:projects.reduce((n,p)=>n+p.assets.length,0), downloaded:0, skipped:0, failed:0 } };
    jobs(ctx)[id] = job; return Response.json({ ok: true, data: { jobId:id,state:'QUEUED' } }, { status:202 });
  }
  if (pathname === '/api/admin/export/status') {
    allowMethod(method,'GET'); const job = Object.values(jobs(ctx)).sort((a,b)=>b.createdAt-a.createdAt)[0];
    if (!job) return { running:false, progress:null };
    const result: ExportStatusResponse = { running:['QUEUED','RUNNING'].includes(job.state), progress:job.progress,
      jobId:job.id,state:job.state,result:job.result,error:job.error }; return result;
  }
  return UNHANDLED;
}
