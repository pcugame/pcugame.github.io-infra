import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../../../application/http-input.js';
import type { ProjectDetailRecord, ProjectUpdateDependencies, ProjectUpdateSnapshot, ProjectUpdateTransaction } from './update.ports.js';
import { createProjectSerializer } from './serializer.js';
import { updateProject } from './update.service.js';

const owner: Actor = { id: 7, role: 'USER' };
const operator: Actor = { id: 8, role: 'OPERATOR' };
function harness(snapshot: Partial<ProjectUpdateSnapshot> = {}) {
	const current: ProjectUpdateSnapshot = { creatorId: owner.id, status: 'PUBLISHED',
		isChangeRequestDraft: false, isMember: false, isModificationEnabled: true, ...snapshot };
	const record: ProjectDetailRecord = { id: 1, creatorId: owner.id, visibility: 'PUBLIC', title: 'Before',
		slug: 'game', summary: '', description: '', githubUrl: '', platforms: [], status: 'PUBLISHED',
		sortOrder: 0, isIncomplete: false, posterAssetId: null, poster: null, assets: [], members: [],
		exhibition: { year: 2026, visibility: 'PUBLIC', isModificationEnabled: current.isModificationEnabled } };
	const apply = vi.fn<ProjectUpdateTransaction['apply']>(async patch => ({ ...record, ...patch }));
	const resolveLinks = vi.fn<ProjectUpdateDependencies['resolveExternalLinks']>(async links => links);
	const preliminary = vi.fn(async () => ({ status: 'PUBLISHED' }));
	const deps: ProjectUpdateDependencies = {
		repository: { runProjectUpdate: async (_id, _actor, operation) => operation({ snapshot: current, apply }) },
		loadProjectWithAccess: preliminary,
		resolveExternalLinks: resolveLinks,
		serializeProjectDetail: createProjectSerializer('http://api.test').serializeProjectDetail,
	};
	return { deps, apply, resolveLinks, preliminary };
}

describe('project update use case', () => {
	it.each(['PUBLISHED', 'ARCHIVED'] as const)('rejects a directly called USER status update to %s before link I/O', async status => {
		const { deps, apply, resolveLinks } = harness();
		await expect(updateProject(deps, 1, { status, externalLinks: [] }, owner)).rejects.toMatchObject({ statusCode: 403 });
		expect(apply).not.toHaveBeenCalled();
		expect(resolveLinks).not.toHaveBeenCalled();
	});
	it.each([
		['membership removal', { creatorId: 99, isMember: false }],
		['exhibition closure', { isModificationEnabled: false }],
		['staging project', { isChangeRequestDraft: true }],
	] as const)('rejects %s from the locked snapshot despite a successful preflight', async (_name, snapshot) => {
		const { deps, apply, preliminary } = harness(snapshot);
		await expect(updateProject(deps, 1, { title: 'Denied' }, owner)).rejects.toMatchObject({ statusCode: 403 });
		expect(preliminary).toHaveBeenCalledOnce();
		expect(apply).not.toHaveBeenCalled();
	});
	it('rechecks DRAFT on the locked snapshot for staff and preserves the finalize-only restriction', async () => {
		const { deps, apply } = harness({ status: 'DRAFT' });
		await expect(updateProject(deps, 1, { status: 'PUBLISHED' }, operator)).rejects.toMatchObject({ statusCode: 409 });
		expect(apply).not.toHaveBeenCalled();
	});
	it('does not grant staff a staging exception', async () => {
		const { deps, apply } = harness({ isChangeRequestDraft: true });
		await expect(updateProject(deps, 1, { title: 'Denied' }, operator)).rejects.toMatchObject({ statusCode: 403 });
		expect(apply).not.toHaveBeenCalled();
	});
	it('allows a linked member to edit and staff to edit a closed exhibition', async () => {
		const member = harness({ creatorId: 99, isMember: true });
		await expect(updateProject(member.deps, 1, { title: 'Member edit' }, owner)).resolves.toMatchObject({ title: 'Member edit' });
		const staff = harness({ isModificationEnabled: false });
		await expect(updateProject(staff.deps, 1, { status: 'ARCHIVED' }, operator)).resolves.toMatchObject({ status: 'ARCHIVED' });
	});
	it('resolves links outside the transaction and passes only defined patch fields', async () => {
		const { deps, apply, resolveLinks } = harness();
		const transaction = deps.repository.runProjectUpdate;
		deps.repository.runProjectUpdate = async (...args) => {
			expect(resolveLinks).toHaveBeenCalledOnce();
			return transaction(...args);
		};
		const result = await updateProject(deps, 1, { title: 'After', externalLinks: [], summary: undefined }, owner);
		expect(apply).toHaveBeenCalledExactlyOnceWith({ title: 'After', externalLinks: [] });
		expect(result).toMatchObject({ title: 'After', members: [], assets: [], canEdit: true });
	});
});
