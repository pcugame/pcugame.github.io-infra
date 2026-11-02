import type { Actor } from '../../../application/http-input.js';
import { capabilities } from './capabilities.js';
import { assertProjectUpdateAllowed, assertStatusTransition } from './update.policy.js';
import type { ProjectUpdateDependencies, ProjectUpdatePatch } from './update.ports.js';

export async function updateProject(deps: ProjectUpdateDependencies, projectId: number, patch: ProjectUpdatePatch, actor: Actor) {
	// Preserve authorization/error precedence before external network work. The
	// authoritative policy below always rechecks the locked, current snapshot.
	const preliminary = await deps.loadProjectWithAccess(actor, projectId);
	if (patch.status !== undefined) assertStatusTransition(preliminary.status, patch.status, actor.role);
	const prepared: ProjectUpdatePatch = {
		...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
		...(patch.title !== undefined ? { title: patch.title } : {}),
		...(patch.summary !== undefined ? { summary: patch.summary } : {}),
		...(patch.description !== undefined ? { description: patch.description } : {}),
		...(patch.platforms !== undefined ? { platforms: patch.platforms } : {}),
		...(patch.hardwareRequirements !== undefined ? { hardwareRequirements: patch.hardwareRequirements } : {}),
		...(patch.externalLinks !== undefined ? { externalLinks: await deps.resolveExternalLinks(patch.externalLinks) } : {}),
		...(patch.isIncomplete !== undefined ? { isIncomplete: patch.isIncomplete } : {}),
		...(patch.status !== undefined ? { status: patch.status } : {}),
		...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
	};
	const updated = await deps.repository.runProjectUpdate(projectId, actor, async tx => {
		assertProjectUpdateAllowed(tx.snapshot, prepared, actor);
		return tx.apply(prepared);
	});
	return {
		...deps.serializeProjectDetail(updated),
		...capabilities(updated, actor.id, actor.role),
		canEditWebglDisplay: actor.role === 'ADMIN' || actor.role === 'OPERATOR'
			|| (updated.creatorId === actor.id && updated.exhibition.isModificationEnabled !== false),
	};
}
