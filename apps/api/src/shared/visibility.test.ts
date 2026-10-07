import { describe, expect, it } from 'vitest';
import { canChangeProjectVisibility, canReadProject, canReadVisibility, type VisibilityActor } from './visibility.js';
import { ImportDataSchema } from '../modules/admin/import/service.js';
import { CreateExhibitionBaseSchema, SubmitProjectPayloadBaseSchema, UpdateProjectBaseSchema, type Visibility } from '@pcu/contracts';

describe('shared visibility policy', () => {
	it('combines both audiences and never grants draft browsing or unrelated ownership', () => {
		const levels: Visibility[] = ['PUBLIC', 'AUTHENTICATED', 'STAFF'];
		const actors: VisibilityActor[] = [null, { id: 1, role: 'USER' }, { id: 2, role: 'USER' }, { id: 3, role: 'USER' }, { id: 4, role: 'OPERATOR' }, { id: 5, role: 'ADMIN' }];
		for (const status of ['PUBLISHED', 'ARCHIVED']) for (const actor of actors) for (const exhibition of levels) for (const visibility of levels) {
			const project = { creatorId: 1, members: [{ userId: 2 }], status, visibility, exhibition: { visibility: exhibition, isModificationEnabled: true } };
			const related = actor?.id === 1 || actor?.id === 2;
			expect(canReadProject(actor, project)).toBe(related || (canReadVisibility(actor, visibility) && canReadVisibility(actor, exhibition)));
			expect(canReadProject(actor, { ...project, status: 'DRAFT' })).toBe(false);
			expect(canChangeProjectVisibility(actor, { ...project, exhibition: { ...project.exhibition, isModificationEnabled: false } })).toBe(actor?.role === 'OPERATOR' || actor?.role === 'ADMIN');
		}
	});
	it('supports old create/import payloads and leaves partial update fields absent', () => {
		expect(CreateExhibitionBaseSchema.parse({ year: 2026 })).not.toHaveProperty('visibility');
		expect(UpdateProjectBaseSchema.parse({ title: 'Keep audience' })).not.toHaveProperty('visibility');
		expect(SubmitProjectPayloadBaseSchema.safeParse({ exhibitionId: 1, title: 'Game', members: [{ name: 'A', studentId: '1' }], visibility: 'INVALID' }).success).toBe(false);
		const imported = ImportDataSchema.parse({ years: [{ year: 2026 }], projects: [{ year: 2026, title: 'Legacy' }] });
		expect(imported.years[0]?.visibility).toBe('PUBLIC'); expect(imported.projects[0]?.visibility).toBe('PUBLIC');
		expect(ImportDataSchema.parse({ years: [{ year: 2026, visibility: 'STAFF' }], projects: [{ year: 2026, title: 'Restricted', visibility: 'AUTHENTICATED' }] }).projects[0]?.visibility).toBe('AUTHENTICATED');
	});
});
