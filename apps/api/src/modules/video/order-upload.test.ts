import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { createAssetUploadRepository } from '../asset-upload/repository.js';
import { createVideoWorkerRepository } from './repository.js';

type Session = { id: string; state: string; resultAssetId: number | null; resultRepresentationId: string | null };
type Video = { id: number; projectId: number; kind: string; status: string; videoSortOrder: number | null; createdAt: Date; representations: Array<Record<string, unknown>> };
function harness(initialOrders: Array<number | null> = []) {
	const assets: Video[] = initialOrders.map((videoSortOrder, index) => ({ id: index + 1, projectId: 7, kind: 'VIDEO', status: 'READY', videoSortOrder, createdAt: new Date(index), representations: [] }));
	const sessions: Session[] = [];
	const items = new Map<string, number>();
	const tx = {
		$queryRaw: vi.fn(async () => [{ id: 7 }]),
		project: {
			findUniqueOrThrow: vi.fn(async () => ({ status: 'PUBLISHED' })),
			findUnique: vi.fn(async () => ({ creatorId: 9, exhibitionId: 1, exhibition: { isModificationEnabled: true }, changeRequestDraft: null })),
			update: vi.fn(async () => ({ id: 7 })),
		},
		user: { findUniqueOrThrow: vi.fn(async () => ({ id: 9, role: 'USER' })) },
		exhibition: { findUniqueOrThrow: vi.fn(async () => ({ isModificationEnabled: true })) },
		projectSubmissionItem: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ kind: 'VIDEO', slot: `video:${items.get(where.id)}`, projectSubmission: { projectId: 7, state: 'PENDING' } })) },
		asset: {
			findMany: vi.fn(async () => [...assets].sort((a, b) => (a.videoSortOrder ?? 99) - (b.videoSortOrder ?? 99) || a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id)),
			findUnique: vi.fn(async ({ where }: { where: { id: number } }) => assets.find(({ id }) => id === where.id)),
			updateMany: vi.fn(async () => { for (const asset of assets) asset.videoSortOrder = null; return { count: assets.length }; }),
			update: vi.fn(async ({ where, data }: { where: { id: number }; data: Partial<Video> }) => Object.assign(assets.find(({ id }) => id === where.id)!, data)),
			create: vi.fn(async ({ data }: { data: Omit<Video, 'id' | 'createdAt' | 'representations'> & { representations: { create: Array<Record<string, unknown>> } } }) => {
				const id = assets.length + 1;
				const asset = { ...data, id, createdAt: new Date(id), representations: data.representations.create.map((r: object, index: number) => ({ ...r, id: `representation-${id}-${index}` })) };
				assets.push(asset);
				return asset;
			}),
		},
		assetUploadSession: {
			count: vi.fn(async ({ where }: { where: { id?: { not: string } } }) => sessions.filter((session) => session.resultAssetId === null && ['ALLOCATING', 'UPLOADING', 'COMPLETING', 'VERIFYING'].includes(session.state) && session.id !== where.id?.not).length),
			findUnique: vi.fn(async ({ where }: { where: { id: string } }) => sessions.find(({ id }) => id === where.id)),
			update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Session> }) => Object.assign(sessions.find(({ id }) => id === where.id)!, data)),
			create: vi.fn(async ({ data }: { data: Session }) => { sessions.push(data); return data; }),
		},
	};
	const client = { $transaction: vi.fn(async (operation: (value: typeof tx) => unknown) => operation(tx)) } as unknown as PrismaClient;
	function addSession(slot?: number) {
		const id = `session-${sessions.length}`;
		const session = { id, projectId: 7, exhibitionId: null, userId: 9, kind: 'VIDEO', state: 'VERIFYING', originalName: 'source.mp4', bucket: 'protected', objectKey: `${id}/source`, generation: 1, sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'identity', resultAssetId: null, resultRepresentationId: null, submissionItemId: slot === undefined ? null : `item-${slot}` };
		if (slot !== undefined) items.set(session.submissionItemId!, slot);
		sessions.push(session);
		return session;
	}
	const worker = createVideoWorkerRepository(client);
	function commit(session: ReturnType<typeof addSession>) {
		return worker.commitVideoOriginalReady({ session: session as never, token: 'lease', originalMimeType: 'video/mp4', originalSizeBytes: 10n, playback: { bucket: session.bucket, objectKey: `${session.id}/playback`, mimeType: 'video/mp4' } });
	}
	const uploads = createAssetUploadRepository(client);
	function allocate() { return uploads.createAllocating({ id: `session-${sessions.length}`, projectId: 7, exhibitionId: null, userId: 9, kind: 'VIDEO', submissionItemId: null } as never); }
	return { assets, sessions, tx, addSession, commit, allocate };
}

describe('project VIDEO allocation and worker ordering', () => {
	it('preserves video:N slots when workers finish in reverse order and on retry', async () => {
		const h = harness();
		const sessions = [0, 1, 2, 3, 4].map((slot) => h.addSession(slot));
		for (const session of [...sessions].reverse()) await h.commit(session);
		expect(h.assets.map(({ videoSortOrder }) => videoSortOrder)).toEqual([4, 3, 2, 1, 0]);
		await h.commit(sessions[4]!);
		expect(h.assets).toHaveLength(5);
		expect(h.assets[0]?.videoSortOrder).toBe(4);
		expect(h.tx.asset.updateMany).not.toHaveBeenCalled();
	});

	it('appends the fifth video without double-counting its active reservation', async () => {
		const h = harness([0, 1, 2, 3]);
		const session = h.addSession();
		await h.commit(session);
		expect(h.assets.map(({ videoSortOrder }) => videoSortOrder)).toEqual([0, 1, 2, 3, 4]);
		expect(session.resultAssetId).toBe(5);
		await expect(h.allocate()).rejects.toMatchObject({ statusCode: 409 });
	});

	it('counts resultless reservations but does not count a committed playback worker twice', async () => {
		const h = harness([0, 1, 2]);
		await h.commit(h.addSession());
		await expect(h.allocate()).resolves.toBeDefined();
		await expect(h.allocate()).rejects.toMatchObject({ statusCode: 409 });
	});

	it('blocks a worker commit when old runtimes have overbooked the project', async () => {
		const h = harness([0, 1, 2, 3]);
		const session = h.addSession();
		h.addSession();
		await expect(h.commit(session)).rejects.toMatchObject({ statusCode: 409 });
		expect(h.tx.asset.create).not.toHaveBeenCalled();
		expect(session.resultAssetId).toBeNull();
	});

	it('normalizes legacy nulls after assigned videos before allocating and appending', async () => {
		const h = harness([null, 0, null]);
		await h.allocate();
		expect(h.assets.map(({ videoSortOrder }) => videoSortOrder)).toEqual([1, 0, 2]);
		await h.commit(h.addSession());
		expect(h.assets[3]?.videoSortOrder).toBe(3);
	});

	it('blocks new allocations for legacy anomalies without deleting existing videos', async () => {
		const h = harness([0, 1, 2, 3, 4, null]);
		await expect(h.allocate()).rejects.toMatchObject({ statusCode: 409 });
		expect(h.assets).toHaveLength(6);
		expect(h.tx.asset.updateMany).not.toHaveBeenCalled();
		expect(h.tx.assetUploadSession.create).not.toHaveBeenCalled();
	});
});
