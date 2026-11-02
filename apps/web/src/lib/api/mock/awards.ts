import { AwardEditSchema, AwardOrderSchema, AwardRecipientsSchema, AwardVersionSchema, type Award, type AwardState } from '@pcu/contracts';
import { MockHttpError, UNHANDLED, type MockContext, type MockProject, type MockRequestOptions } from './context';
import { bodyObject, allowMethod, parseInput } from './common';

// Older version-2 snapshots have no award state. Initialize lazily without
// resetting projects, uploads, or authentication.
export function awardState(ctx: MockContext, id: number): AwardState {
 const states = ctx.state.awards ??= {};
 const state = states[id] ??= { version: 0, items: [], assets: [], projects: [] };
 state.projects = Object.values(ctx.state.projects).filter(p => p.exhibitionId === id && !p.isChangeRequestDraft).map(p => ({ id: p.id, title: p.title }));
 return state;
}
export function projectAwards(ctx: MockContext, p: MockProject): Award[] {
 return (ctx.state.awards?.[p.exhibitionId]?.items ?? []).filter(a => a.projectIds.includes(p.id)).map(({ projectIds: _ids, ...award }) => { void _ids; return award; }).sort((a,b) => a.sortOrder-b.sortOrder||a.id-b.id);
}
export function compareMockProjects(ctx: MockContext, a: MockProject, b: MockProject): number {
 const group = (ctx.state.exhibitions.find(e => e.id === a.exhibitionId)?.sortOrder ?? 0) - (ctx.state.exhibitions.find(e => e.id === b.exhibitionId)?.sortOrder ?? 0) || a.exhibitionId-b.exhibitionId;
 if (group) return group;
 const ar = projectAwards(ctx,a)[0]?.sortOrder ?? Infinity, br = projectAwards(ctx,b)[0]?.sortOrder ?? Infinity;
 return (ar !== br ? ar < br ? -1 : 1 : 0) || Number(!!b.poster)-Number(!!a.poster) || a.sortOrder-b.sortOrder || a.id-b.id;
}
export function clearProjectAwards(ctx: MockContext, projectId: number) {
 for (const state of Object.values(ctx.state.awards ?? {})) {
  if (state.items.some(a => a.projectIds.includes(projectId))) {
   for (const a of state.items) a.projectIds = a.projectIds.filter(id => id !== projectId);
   state.version++;
  }
 }
}
export function handleAwards(ctx: MockContext, path: string, method: string, options: MockRequestOptions): unknown {
 const exhibition = path.match(/^\/api\/admin\/exhibitions\/(\d+)\/(awards(?:\/(order|\d+)(\/recipients)?)?|award-images\/(\d+))$/);
 const project = path.match(/^\/api\/admin\/projects\/(\d+)\/awards$/);
 if (!exhibition && !project) return UNHANDLED;
 ctx.requireAdmin();
 const p = project ? ctx.state.projects[Number(project[1])] : undefined;
 const id = exhibition ? Number(exhibition[1]) : p?.exhibitionId;
 if (!id || !ctx.state.exhibitions.some(e => e.id === id) || (project && (!p || p.isChangeRequestDraft))) throw new MockHttpError(404,'NOT_FOUND','Not found');
 const state = awardState(ctx,id);
 if (exhibition && exhibition[2] === 'awards' && method === 'GET') return state;
 const body = bodyObject(options);
 const { expectedVersion } = parseInput(AwardVersionSchema,{ expectedVersion: body.expectedVersion });
 if (expectedVersion !== state.version) throw new MockHttpError(409,'CONFLICT','수상 설정이 변경되었습니다. 다시 조회해 주세요.');
 const fail = (message: string): never => { throw new MockHttpError(400,'VALIDATION_ERROR',message); };
 if (project || exhibition?.[3] === 'order') {
  allowMethod(method,'PUT'); const { awardIds } = parseInput(AwardOrderSchema,body);
  if (awardIds.some(id => !state.items.some(a => a.id === id))) fail('Invalid awards');
  if (project) for (const a of state.items) a.projectIds = [...a.projectIds.filter(id => id !== p!.id), ...(awardIds.includes(a.id) ? [p!.id] : [])];
  else { if (awardIds.length !== state.items.length) fail('Invalid order'); for (const a of state.items) a.sortOrder = awardIds.indexOf(a.id); }
 } else if (exhibition?.[5]) {
  allowMethod(method,'DELETE'); const assetId = Number(exhibition[5]);
  if (state.items.some(a => a.assetId === assetId)) throw new MockHttpError(409,'CONFLICT','사용 중인 이미지입니다.');
  if (!state.assets.some(a => a.id === assetId)) throw new MockHttpError(404,'NOT_FOUND','Image not found');
  state.assets = state.assets.filter(a => a.id !== assetId);
 } else {
  const awardId = Number(exhibition?.[3]); const award = state.items.find(a => a.id === awardId);
  if (awardId && !award) throw new MockHttpError(404,'NOT_FOUND','Award not found');
  if (exhibition?.[4]) {
   allowMethod(method,'PATCH'); const { addProjectIds, removeProjectIds } = parseInput(AwardRecipientsSchema,body);
   if ([...addProjectIds,...removeProjectIds].some(id => !state.projects.some(p => p.id === id))) fail('Invalid projects');
   award!.projectIds = [...new Set([...award!.projectIds.filter(id => !removeProjectIds.includes(id)), ...addProjectIds])];
  } else if (method === 'DELETE' && award) state.items = state.items.filter(a => a.id !== award.id);
  else {
   allowMethod(method,award ? 'PATCH' : 'POST'); const { name, builtinKey, assetId } = parseInput(AwardEditSchema,body);
   if (state.items.some(a => a.name === name && a.id !== awardId)) throw new MockHttpError(409,'CONFLICT','같은 이름의 상이 있습니다.');
   const asset = state.assets.find(a => a.id === assetId);
   if (assetId !== null && !asset) fail('Invalid image');
   const fields = { name, builtinKey, assetId, imageUrl: asset?.imageUrl };
   if (award) Object.assign(award,fields);
   else { ctx.state.counters.award = (ctx.state.counters.award ?? 0) + 1; state.items.push({ ...fields, id: ctx.state.counters.award, sortOrder: Math.max(-1,...state.items.map(a => a.sortOrder))+1, projectIds: [] }); }
  }
 }
 state.items.sort((a,b) => a.sortOrder-b.sortOrder||a.id-b.id); state.version++; return state;
}
