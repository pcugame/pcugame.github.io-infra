import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalLink } from '@pcu/contracts';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createProjectChangeRepository } from '../modules/project-change/repository.js';

const checks = vi.hoisted(() => ({ apply: vi.fn(), enrich: vi.fn() }));
vi.mock('../modules/project-change/transaction.js', () => ({
	isOperator: (actor: { role: string }) => actor.role === 'ADMIN' || actor.role === 'OPERATOR',
	lockProject: vi.fn(), isOwner: vi.fn(), deleteProjectInTransaction: vi.fn(),
	validateSource: vi.fn(async () => ({ id: 1, version: 1 })), validateChanges: vi.fn(),
	applyProjectChange: checks.apply,
}));
vi.mock('../modules/external-links/resolver.js', () => ({ enrichExternalLinks: checks.enrich }));

function repository(initialLinks?: ExternalLink[], lockedLinks = initialLinks, state = 'PENDING') {
	const time = new Date('2026-10-01T00:00:00Z');
	let row = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', projectId: 1, originalProjectId: 1, projectTitle: 'Game', actorId: 7, kind: 'EDIT', state, baseVersion: 1, reason: 'Update links', reviewReason: null, reviewerId: null, error: null, createdAt: time, updatedAt: time, submittedAt: time, reviewedAt: null, completedAt: null, stagingProjectId: null, before: {}, changes: lockedLinks === undefined ? {} : { externalLinks: lockedLinks }, project: { creatorId: 7, members: [] }, stagingProject: null };
	const write = vi.fn(async ({ data }: { data: Record<string, unknown> }) => { row = { ...row, ...data }; return row; });
	const tx = { $queryRaw: vi.fn(), projectChangeRequest: { findUnique: vi.fn(async () => row), findUniqueOrThrow: vi.fn(async () => row), update: write } };
	const transaction = vi.fn(async (run: (value: typeof tx) => unknown) => run(tx));
	const find = vi.fn(async () => ({ ...row, changes: initialLinks === undefined ? {} : { externalLinks: initialLinks } }));
	const client = { projectChangeRequest: { findUnique: find }, $transaction: transaction } as unknown as PrismaClient;
	return { repository: createProjectChangeRepository(client), write, transaction };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('approval re-verification and snapshot fencing', () => {
	it.each(['approve', 'retry'] as const)('replaces stored client hints before %s applies changes and resolves before locking', async (action) => {
		const links: ExternalLink[] = [{ label: 'Short link', url: 'https://short.example/video', service: 'github' }];
		const enriched = [{ label: 'Short link', url: 'https://short.example/video', service: 'youtube' }];
		const fixture = repository(links, links, action === 'retry' ? 'FAILED' : 'PENDING');
		checks.enrich.mockImplementation(async (input) => { expect(fixture.transaction).not.toHaveBeenCalled(); expect(input).toEqual(links); return enriched; });
		await fixture.repository.transition({ id: 8, role: 'OPERATOR' }, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', action);
		expect(fixture.write).toHaveBeenCalledWith(expect.objectContaining({ data: { changes: { externalLinks: enriched } } }));
		expect(checks.apply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ changes: { externalLinks: enriched } }));
	});
	it.each([
		[undefined, [{ label: 'Added', url: 'https://github.com/game' }]],
		[[{ label: 'Initial', url: 'https://github.com/old' }], [{ label: 'Replaced', url: 'https://github.com/new' }]],
	])('rejects any external link snapshot change before approval', async (initial, locked) => {
		checks.enrich.mockResolvedValue([]);
		const fixture = repository(initial, locked);
		await expect(fixture.repository.transition({ id: 8, role: 'ADMIN' }, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'approve')).rejects.toMatchObject({ statusCode: 409 });
		expect(checks.apply).not.toHaveBeenCalled(); expect(fixture.write).not.toHaveBeenCalled();
	});
	it('rejects a nonoperator before inspecting or resolving stored URLs', async () => {
		const fixture = repository([{ label: 'Link', url: 'https://short.example/' }]);
		await expect(fixture.repository.transition({ id: 7, role: 'USER' }, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'approve')).rejects.toMatchObject({ statusCode: 403 });
		expect(checks.enrich).not.toHaveBeenCalled(); expect(fixture.transaction).not.toHaveBeenCalled();
	});
});
