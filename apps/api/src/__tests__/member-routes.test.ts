import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { memberController } from '../modules/admin/member/index.js';

const mocks = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
	projectMemberFindFirst: vi.fn(),
	projectMemberUpdate: vi.fn(),
	projectMemberCreate: vi.fn(),
	projectMemberDelete: vi.fn(),
	transaction: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
	prisma: {
		project: {
			findUnique: mocks.projectFindUnique,
		},
		projectMember: {
			findFirst: mocks.projectMemberFindFirst,
			update: mocks.projectMemberUpdate,
			create: mocks.projectMemberCreate,
			delete: mocks.projectMemberDelete,
		},
		$transaction: mocks.transaction,
	},
}));

vi.mock('../plugins/auth.js', () => {
	function httpError(statusCode: number, message: string, code: string) {
		const err = new Error(message) as Error & { statusCode: number; code: string };
		err.statusCode = statusCode;
		err.code = code;
		return err;
	}

	return {
		requireLogin: async (request: any) => {
			const id = Number(request.headers['x-test-user-id']);
			const role = request.headers['x-test-role'] ?? 'USER';
			if (!Number.isInteger(id) || id <= 0) {
				throw httpError(401, 'Unauthorized', 'UNAUTHORIZED');
			}
			request.currentUser = {
				id,
				googleSub: `test-${id}`,
				email: `user-${id}@g.pcu.ac.kr`,
				name: `User ${id}`,
				role,
				studentId: String(id),
			};
		},
	};
});

type TestRole = 'USER' | 'OPERATOR' | 'ADMIN';

type TestProject = {
	id: number;
	creatorId: number;
};

type TestMember = {
	id: number;
	projectId: number;
	name: string;
	studentId: string;
	sortOrder: number;
	userId: number | null;
};

let app: FastifyInstance;
let project: TestProject;
let members: TestMember[];

function targetMember() {
	const member = members.find((m) => m.id === 11);
	if (!member) throw new Error('missing target member');
	return member;
}

function installPrismaMocks() {
	mocks.projectFindUnique.mockImplementation(({ where }: { where: { id: number } }) => (
		where.id === project.id ? { ...project } : null
	));

	mocks.projectMemberFindFirst.mockImplementation(({ where }: { where: { id?: number; projectId?: number; userId?: number } }) => {
		if (where.id !== undefined) {
			return members.find((m) => m.id === where.id && m.projectId === where.projectId) ?? null;
		}
		if (where.projectId !== undefined && where.userId !== undefined) {
			return members.find((m) => m.projectId === where.projectId && m.userId === where.userId) ?? null;
		}
		return null;
	});

	mocks.projectMemberUpdate.mockImplementation((args: {
		where: { id: number };
		data: Partial<Pick<TestMember, 'name' | 'studentId' | 'sortOrder' | 'userId'>>;
	}) => {
		const member = members.find((m) => m.id === args.where.id);
		if (!member) throw new Error('missing member');
		Object.assign(member, args.data);
		return { ...member };
	});
}

async function buildTestApp() {
	const testApp = Fastify({ logger: false });
	testApp.setErrorHandler((error: any, _request, reply) => {
		reply.status(error.statusCode ?? 500).send({
			ok: false,
			error: {
				code: error.code ?? 'ERROR',
				message: error.message,
				...(error.details !== undefined ? { details: error.details } : {}),
			},
		});
	});
	await testApp.register(memberController, { prefix: '/api/admin' });
	return testApp;
}

function patchMember(userId: number, role: TestRole, payload: Record<string, unknown>) {
	return app.inject({
		method: 'PATCH',
		url: '/api/admin/projects/1/members/11',
		headers: {
			'x-test-user-id': String(userId),
			'x-test-role': role,
		},
		payload,
	});
}

describe('member profile routes', () => {
	beforeAll(async () => {
		app = await buildTestApp();
		await app.ready();
	});

	afterAll(async () => {
		await app.close();
	});

	beforeEach(() => {
		mocks.projectFindUnique.mockReset();
		mocks.projectMemberFindFirst.mockReset();
		mocks.projectMemberUpdate.mockReset();
		mocks.projectMemberCreate.mockReset();
		mocks.projectMemberDelete.mockReset();
		mocks.transaction.mockReset();

		project = { id: 1, creatorId: 999 };
		members = [
			{ id: 10, projectId: 1, name: 'Writer', studentId: '20240001', sortOrder: 0, userId: 101 },
			{ id: 11, projectId: 1, name: 'Target', studentId: '20240002', sortOrder: 1, userId: null },
		];
		installPrismaMocks();
	});

	it('allows a linked USER project writer to update member profile fields', async () => {
		const res = await patchMember(101, 'USER', {
			name: 'Updated',
			studentId: '20249999',
			sortOrder: 3,
		});

		expect(res.statusCode).toBe(204);
		expect(targetMember()).toMatchObject({
			name: 'Updated',
			studentId: '20249999',
			sortOrder: 3,
			userId: null,
		});
		expect(mocks.projectMemberUpdate).toHaveBeenCalledWith({
			where: { id: 11 },
			data: {
				name: 'Updated',
				studentId: '20249999',
				sortOrder: 3,
			},
		});
	});

	it.each([
		['set', null, 202],
		['change', 303, 202],
		['clear', 303, null],
	] as const)('rejects a USER attempt to %s member userId', async (_label, initialUserId, requestedUserId) => {
		targetMember().userId = initialUserId;

		const res = await patchMember(101, 'USER', { userId: requestedUserId });

		expect(res.statusCode).toBe(400);
		expect(targetMember().userId).toBe(initialUserId);
		expect(mocks.projectMemberUpdate).not.toHaveBeenCalled();
	});

	it.each(['USER', 'OPERATOR', 'ADMIN'] as const)(
		'rejects userId on the shared profile edit path for %s',
		async (role) => {
			const actingUserId = role === 'USER' ? 101 : 500;

			const res = await patchMember(actingUserId, role, { userId: 202 });

			expect(res.statusCode).toBe(400);
			expect(targetMember().userId).toBeNull();
			expect(mocks.projectMemberUpdate).not.toHaveBeenCalled();
		},
	);

	it('does not grant project access to an injected userId', async () => {
		const injection = await patchMember(101, 'USER', { userId: 202 });
		expect(injection.statusCode).toBe(400);
		expect(targetMember().userId).toBeNull();

		const denied = await patchMember(202, 'USER', { name: 'Intruder' });

		expect(denied.statusCode).toBe(403);
		expect(targetMember()).toMatchObject({
			name: 'Target',
			userId: null,
		});
		expect(mocks.projectMemberUpdate).not.toHaveBeenCalled();
	});
});
