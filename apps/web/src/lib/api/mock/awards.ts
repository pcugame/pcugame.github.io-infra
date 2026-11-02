import { AwardEditSchema, AwardOrderSchema, AwardRecipientsSchema, AwardVersionSchema, type AwardState } from '@pcu/contracts';
import { MockHttpError, UNHANDLED, type MockContext, type MockProject, type MockRequestOptions } from './context';
import { allowMethod, bodyObject, conflict, missing, parseInput } from './common';

export function getMockAwardState(ctx: MockContext, exhibitionId: number): AwardState {
  if (!ctx.state.exhibitions.some(e => e.id === exhibitionId)) missing('전시회를 찾을 수 없습니다.');
  const projects = Object.values(ctx.state.projects).filter(p => p.exhibitionId === exhibitionId && !p.isChangeRequestDraft && p.status !== 'DRAFT');
  const saved = (ctx.state.awards ??= {});
  const result = saved[exhibitionId] ??= {
    version: 0, assets: [], projects: [],
    items: ['대상', '최우수상', '우수상'].map((name, index) => ({
      id: exhibitionId * 1000 + index + 1, name, sortOrder: index,
      builtinKey: (['trophy', 'medal', 'ribbon'] as const)[index], assetId: null,
      projectIds: projects[index] ? [projects[index].id] : [],
    })),
  };
  result.projects = projects.map(p => ({ id: p.id, title: p.title }));
  result.items.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  for (const [index, award] of result.items.entries()) {
    award.displayRank = index + 1;
    const image = result.assets.find(asset => asset.id === award.assetId);
    if (image?.imageUrl) award.imageUrl = image.imageUrl; else delete award.imageUrl;
  }
  return result;
}
export function mockProjectAwards(ctx: MockContext, project: MockProject) {
  return getMockAwardState(ctx, project.exhibitionId).items.filter(a => a.projectIds.includes(project.id)).map(({ projectIds, ...award }) => { void projectIds; return award; });
}
export function handleAwards(ctx: MockContext, pathname: string, method: string, options: MockRequestOptions) {
  const exhibitionRoute = pathname.match(/^\/api\/admin\/exhibitions\/(\d+)\/awards(?:\/(order|\d+)(?:\/(recipients))?)?$/);
  const projectRoute = pathname.match(/^\/api\/admin\/projects\/(\d+)\/awards$/);
  const imageRoute = pathname.match(/^\/api\/admin\/exhibitions\/(\d+)\/award-images\/(\d+)$/);
  if (!exhibitionRoute && !projectRoute && !imageRoute) return UNHANDLED;
  ctx.requireAdmin();
  const project = projectRoute ? ctx.state.projects[Number(projectRoute[1])] : undefined;
  if (projectRoute && !project) missing();
  const current = getMockAwardState(ctx, project?.exhibitionId ?? Number(exhibitionRoute?.[1] ?? imageRoute![1]));
  if (exhibitionRoute && !exhibitionRoute[2] && method === 'GET') return current;
  const body = bodyObject(options);
  if (body.expectedVersion !== current.version) conflict('수상 설정이 변경되었습니다. 다시 조회해 주세요.');
  if (imageRoute) {
    allowMethod(method, 'DELETE'); parseInput(AwardVersionSchema, body);
    const assetId = Number(imageRoute[2]);
    if (current.items.some(award => award.assetId === assetId)) conflict('사용 중인 이미지입니다. 상의 이미지를 먼저 변경해 주세요.');
    if (!current.assets.some(asset => asset.id === assetId)) missing('Image not found');
    current.assets = current.assets.filter(asset => asset.id !== assetId);
  } else if (projectRoute || exhibitionRoute?.[2] === 'order') {
    allowMethod(method, 'PUT');
    const { awardIds } = parseInput(AwardOrderSchema, body);
    if (awardIds.some(id => !current.items.some(a => a.id === id))) missing('상을 찾을 수 없습니다.');
    if (project) {
      if (!current.projects.some(p => p.id === project.id)) missing('수상 대상 작품이 아닙니다.');
      for (const award of current.items) award.projectIds = [...award.projectIds.filter(id => id !== project.id), ...(awardIds.includes(award.id) ? [project.id] : [])];
    } else {
      if (awardIds.length !== current.items.length) throw new MockHttpError(400, 'VALIDATION_ERROR', '모든 상을 포함해야 합니다.');
      current.items = awardIds.map((id, sortOrder) => ({ ...current.items.find(a => a.id === id)!, sortOrder }));
    }
  } else if (!exhibitionRoute![2]) {
    allowMethod(method, 'POST');
    const { expectedVersion, ...input } = parseInput(AwardEditSchema, body); void expectedVersion;
    if (input.assetId !== null && !current.assets.some(asset => asset.id === input.assetId)) throw new MockHttpError(400, 'VALIDATION_ERROR', '이 전시회의 처리 완료 이미지가 필요합니다.');
    const id = Math.max(0, ctx.state.counters.award ?? 0, ...Object.values(ctx.state.awards!).flatMap(s => s.items.map(a => a.id))) + 1;
    ctx.state.counters.award = id;
    current.items.push({ ...input, id, sortOrder: current.items.length, projectIds: [] });
  } else {
    const award = current.items.find(a => a.id === Number(exhibitionRoute![2]));
    if (!award) missing('상을 찾을 수 없습니다.');
    if (exhibitionRoute![3]) {
      allowMethod(method, 'PATCH');
      const input = parseInput(AwardRecipientsSchema, body);
      if (input.addProjectIds.some(id => !current.projects.some(p => p.id === id))) missing('수상 대상 작품을 찾을 수 없습니다.');
      award.projectIds = [...new Set([...award.projectIds.filter(id => !input.removeProjectIds.includes(id)), ...input.addProjectIds])];
    } else if (method === 'DELETE') {
      parseInput(AwardVersionSchema, body);
      current.items = current.items.filter(a => a.id !== award.id);
      current.items.forEach((a, index) => { a.sortOrder = index; });
    } else {
      allowMethod(method, 'PATCH');
      const { expectedVersion, ...input } = parseInput(AwardEditSchema, body); void expectedVersion;
      if (input.assetId !== null && !current.assets.some(asset => asset.id === input.assetId)) throw new MockHttpError(400, 'VALIDATION_ERROR', '이 전시회의 처리 완료 이미지가 필요합니다.');
      Object.assign(award, input);
    }
  }
  current.version++;
  return getMockAwardState(ctx, project?.exhibitionId ?? Number(exhibitionRoute?.[1] ?? imageRoute![1]));
}
