import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { test, expect } from '@playwright/test';
import Fastify from 'fastify';
import { createGameUploadService } from '../apps/api/src/modules/admin/game-upload/service.js';
import {
	SOURCE_IDENTITY_ALGORITHM,
	SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
	sourceIdentityRoot,
} from '../apps/api/src/modules/admin/game-upload/source-identity.js';
import { AppError } from '../apps/api/src/shared/errors.js';
import type {
	GameUploadPartRecord,
	GameUploadServiceDependencies,
	GameUploadSessionRecord,
} from '../apps/api/src/modules/admin/game-upload/ports.js';

const FILE_SIZE = SOURCE_IDENTITY_BLOCK_SIZE_BYTES * 2;
const API_ORIGIN = 'http://localhost:4000';
const SESSION_ID = 'd3-e2e-session';
const USER = { id: 11, role: 'USER' };

type Identity = {
	sourceIdentityAlgorithm: typeof SOURCE_IDENTITY_ALGORITHM;
	sourceIdentity: string;
	sourceIdentityBlockSizeBytes: typeof SOURCE_IDENTITY_BLOCK_SIZE_BYTES;
	sourceIdentityBlockDigests: string[];
};

function crc32(bytes: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (-(crc & 1) & 0xedb88320);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/** A deterministic stored ZIP of exactly two manifest blocks. */
function equalLengthZip(fill: number): Buffer {
	const filename = Buffer.from('build.bin');
	const payloadLength = FILE_SIZE - (30 + filename.length) - (46 + filename.length) - 22;
	const payload = Buffer.alloc(payloadLength, fill);
	const checksum = crc32(payload);
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt32LE(checksum, 14);
	local.writeUInt32LE(payload.length, 18);
	local.writeUInt32LE(payload.length, 22);
	local.writeUInt16LE(filename.length, 26);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt32LE(checksum, 16);
	central.writeUInt32LE(payload.length, 20);
	central.writeUInt32LE(payload.length, 24);
	central.writeUInt16LE(filename.length, 28);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length + filename.length, 12);
	end.writeUInt32LE(local.length + filename.length + payload.length, 16);
	return Buffer.concat([local, filename, payload, central, filename, end]);
}

function identityOf(bytes: Buffer): Identity {
	const blockDigests: string[] = [];
	for (let offset = 0; offset < bytes.length; offset += SOURCE_IDENTITY_BLOCK_SIZE_BYTES) {
		blockDigests.push(createHash('sha256').update(bytes.subarray(offset, offset + SOURCE_IDENTITY_BLOCK_SIZE_BYTES)).digest('hex'));
	}
	return {
		sourceIdentityAlgorithm: SOURCE_IDENTITY_ALGORITHM,
		sourceIdentity: sourceIdentityRoot(bytes.length, SOURCE_IDENTITY_BLOCK_SIZE_BYTES, blockDigests),
		sourceIdentityBlockSizeBytes: SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
		sourceIdentityBlockDigests: blockDigests,
	};
}

const SOURCE_A = equalLengthZip(0x41);
const SOURCE_B = equalLengthZip(0x42);
const IDENTITY_A = identityOf(SOURCE_A);
const IDENTITY_B = identityOf(SOURCE_B);

function sessionStatus(uploadedChunks: number[]) {
	return {
		sessionId: SESSION_ID,
		originalName: 'resume-a.zip',
		totalBytes: SOURCE_A.length,
		chunkSizeBytes: SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
		totalChunks: 2,
		uploadedChunks,
		uploadedCount: uploadedChunks.length,
		status: 'PENDING',
		expiresAt: '2026-08-21T00:00:00.000Z',
		uploadKind: 'WEBGL',
		...IDENTITY_A,
	};
}

async function installResumeRoutes(page: import('@playwright/test').Page, uploadedChunks: number[]) {
	const objects = new Map<number, Buffer>();
	if (uploadedChunks.includes(0)) objects.set(0, Buffer.from(SOURCE_A.subarray(0, SOURCE_IDENTITY_BLOCK_SIZE_BYTES)));
	const putRequests: Buffer[] = [];
	let completed = false;
	await page.route(`${API_ORIGIN}/**`, async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (request.method() === 'GET' && url.pathname === '/api/admin/projects/7/game-upload-sessions') {
			return route.fulfill({ json: { ok: true, data: { items: [sessionStatus(uploadedChunks)] } } });
		}
		if (request.method() === 'GET' && url.pathname === `/api/admin/game-upload-sessions/${SESSION_ID}`) {
			return route.fulfill({ json: { ok: true, data: sessionStatus(uploadedChunks) } });
		}
		if (request.method() === 'PUT' && /\/chunks\/\d+$/.test(url.pathname)) {
			if (url.searchParams.get('sourceIdentityAlgorithm') !== IDENTITY_A.sourceIdentityAlgorithm
				|| url.searchParams.get('sourceIdentity') !== IDENTITY_A.sourceIdentity) {
				return route.fulfill({
					status: 400,
					json: { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Missing source identity query' } },
				});
			}
			const index = Number(url.pathname.split('/').pop());
			const body = request.postDataBuffer() ?? Buffer.alloc(0);
			putRequests.push(Buffer.from(body));
			objects.set(index, Buffer.from(body));
			return route.fulfill({ json: { ok: true, data: { index, bytesWritten: body.length, uploadedCount: 2, totalChunks: 2 } } });
		}
		if (request.method() === 'POST' && url.pathname === `/api/admin/game-upload-sessions/${SESSION_ID}/complete`) {
			completed = true;
			return route.fulfill({ json: { ok: true, data: { storageKey: 'webgl/a.zip' } } });
		}
		return route.fulfill({ status: 500, json: { ok: false, error: { code: 'ERROR', message: 'Unexpected E2E request' } } });
	});
	return { objects, putRequests, get completed() { return completed; } };
}

function uploadFile(name: string, buffer: Buffer) {
	return { name, mimeType: 'application/zip', buffer };
}

test.beforeAll(() => {
	expect(SOURCE_A.length).toBe(SOURCE_B.length);
	expect(SOURCE_A.equals(SOURCE_B)).toBeFalsy();
	expect(IDENTITY_A.sourceIdentity).not.toBe(IDENTITY_B.sourceIdentity);
});

test('Scenario 1: the real Worker hashes A, resumes its remaining part, and completes', async ({ page }) => {
	const fixture = await installResumeRoutes(page, [0]);
	await page.goto('/e2e/');
	await expect(page.getByText('미완료 업로드가 있습니다:')).toBeVisible();
	await page.locator('input[type="file"]').setInputFiles(uploadFile('resume-a.zip', SOURCE_A));
	await page.getByRole('button', { name: '이어올리기' }).click();
	await expect(page.getByText('업로드 완료', { exact: true })).toBeVisible();
	expect(fixture.putRequests).toHaveLength(1);
	expect(fixture.putRequests[0]).toEqual(SOURCE_A.subarray(SOURCE_IDENTITY_BLOCK_SIZE_BYTES));
	expect(fixture.objects.get(0)).toEqual(SOURCE_A.subarray(0, SOURCE_IDENTITY_BLOCK_SIZE_BYTES));
	expect(fixture.completed).toBeTruthy();
});

test('Scenario 2: same-size B is rejected before any chunk PUT and A state remains intact', async ({ page }) => {
	const fixture = await installResumeRoutes(page, [0]);
	const originalAChunk = Buffer.from(fixture.objects.get(0)!);
	await page.goto('/e2e/');
	await page.locator('input[type="file"]').setInputFiles(uploadFile('resume-b.zip', SOURCE_B));
	await page.getByRole('button', { name: '이어올리기' }).click();
	await expect(page.getByText('선택한 파일이 이 업로드 세션을 시작한 파일과 다릅니다. 원래 파일을 선택하거나 새 업로드를 시작하세요.')).toBeVisible();
	expect(fixture.putRequests).toHaveLength(0);
	expect(fixture.objects.get(0)).toEqual(originalAChunk);
	expect(fixture.completed).toBeFalsy();
});

function createHttpUploadFixture() {
	const parts = new Map<number, GameUploadPartRecord>();
	const objects = new Map<number, Buffer>();
	let storageWrites = 0;
	const record: GameUploadSessionRecord = {
		id: SESSION_ID,
		projectId: 7,
		userId: USER.id,
		uploadKind: 'WEBGL',
		originalName: 'resume-a.zip',
		totalBytes: BigInt(SOURCE_A.length),
		chunkSizeBytes: SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
		totalChunks: 2,
		uploadedChunks: [], status: 'PENDING', expiresAt: new Date(Date.now() + 60_000),
		s3UploadId: 'multipart-d3', s3Key: 'protected/d3.zip', storageKey: null, parts: [], multipartGeneration: 1,
		project: { status: 'PUBLISHED' },
		sourceIdentityAlgorithm: IDENTITY_A.sourceIdentityAlgorithm,
		sourceIdentity: IDENTITY_A.sourceIdentity,
		sourceIdentityBlockSizeBytes: IDENTITY_A.sourceIdentityBlockSizeBytes,
		sourceIdentityBlockManifest: Buffer.from(IDENTITY_A.sourceIdentityBlockDigests.join(''), 'hex'),
	};
	const repository = {
		findSessionById: async () => ({ ...record, parts: [...parts.values()] }),
		acquirePartClaim: async (input: { partNumber: number; contentSha256: string; token: string }) => {
			const existing = parts.get(input.partNumber);
			if (!existing) return { kind: 'acquired' as const, token: input.token };
			return existing.contentSha256 === input.contentSha256
				? { kind: 'already-uploaded' as const, parts: [...parts.values()] }
				: { kind: 'conflict' as const };
		},
		completePartClaim: async (input: { etag: string; contentSha256: string }) => {
			parts.set(1, { partNumber: 1, etag: input.etag, contentSha256: input.contentSha256, generation: 1 });
			return { accepted: true, parts: [...parts.values()] };
		},
		findPartsBySessionId: async () => [...parts.values()],
		createSessionReplacingActive: async () => ({ session: { id: SESSION_ID }, durableAborts: [] }),
		cancelSessionAndClearActive: async () => ({ count: 0 as const, durableAbort: null }),
		queueAbortTask: async () => undefined,
		renewPartClaim: async () => ({ count: 1 }),
		claimCompletion: async () => ({ count: 1, reason: null }),
		renewCompletionClaim: async () => ({ count: 1 }),
		releaseCompletionClaim: async () => ({ count: 1 }),
		replaceMultipartGeneration: async () => ({ replaced: true, durableAbort: null }),
		findActiveSessionsForListing: async () => [], findExhibitionById: async () => null,
		findExpiredPendingSessions: async () => [], findSessionsWithExpiredPartClaims: async () => [],
		findKnownMultipartUploads: async () => [], claimStaleCompletingSessions: async () => [],
		revertToPending: async () => undefined, markFailed: async () => undefined,
		markCompletedObjectFailed: async () => ({ count: 1 }),
	};
	const deps = {
		repository,
		storage: {
			createMultipart: async () => 'multipart-new', abortMultipart: async () => undefined,
			uploadPart: async (_key: string, _uploadId: string, partNumber: number, body: Readable) => {
				const chunks: Buffer[] = [];
				for await (const chunk of body) chunks.push(Buffer.from(chunk));
				storageWrites += 1; objects.set(partNumber, Buffer.concat(chunks)); return `etag-${partNumber}`;
			},
			completeMultipart: async () => undefined, listParts: async () => [...parts.values()],
			listMultipartUploads: async () => [], head: async () => ({ size: SOURCE_A.length, contentType: 'application/zip' }),
		},
		finalizer: { finalize: async () => ({ storageKey: 'protected/d3.zip' }) },
		settings: { get: async () => ({ maxGameFileMb: 5120, maxChunkSizeMb: 1 }) },
		uploadSlots: { acquire() {}, release() {} }, clock: { now: () => new Date() }, ids: { next: () => 'claim-d3' },
		lifecycle: { isAcceptingNewWork: () => true }, config: { uploadChunkSizeMb: 1, uploadSessionTtlMinutes: 60 },
		roleGameMaxBytes: () => 5120 * 1024 * 1024, storageKey: () => 'protected/d3.zip',
		deleteOrQueue: async () => undefined, wakeDeletionWorker() {}, wakeMaintenance() {}, recordUntrackedMultipartCleanupFailure() {},
		logger: { error() {}, warn() {}, fatal() {} },
	} as unknown as GameUploadServiceDependencies;
	const service = createGameUploadService(deps);
	const app = Fastify();
	app.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));
	app.put('/sessions/:sessionId/chunks/:index', async (request, reply) => {
		try {
			const result = await service.uploadChunk(
				(request.params as { sessionId: string }).sessionId,
				Number((request.params as { index: string }).index),
				request.body as NodeJS.ReadableStream,
				USER,
				request.query as { sourceIdentityAlgorithm?: string; sourceIdentity?: string },
			);
			return reply.send({ ok: true, data: result });
		} catch (error) {
			if (error instanceof AppError) return reply.status(error.statusCode).send({ ok: false, error: { code: error.code, message: error.message, details: error.details } });
			throw error;
		}
	});
	return { app, objects, get storageWrites() { return storageWrites; } };
}

test('Scenario 3 and 4: direct HTTP conflict cannot replace A, while A retry is idempotent', async ({ request }) => {
	const fixture = createHttpUploadFixture();
	const address = await fixture.app.listen({ port: 0, host: '127.0.0.1' });
	const endpoint = `${address}/sessions/${SESSION_ID}/chunks/0?sourceIdentityAlgorithm=${IDENTITY_A.sourceIdentityAlgorithm}&sourceIdentity=${IDENTITY_A.sourceIdentity}`;
	try {
		const first = await request.put(endpoint, { data: SOURCE_A.subarray(0, SOURCE_IDENTITY_BLOCK_SIZE_BYTES), headers: { 'content-type': 'application/octet-stream' } });
		expect(first.status()).toBe(200);
		const storedA = Buffer.from(fixture.objects.get(1)!);
		const retry = await request.put(endpoint, { data: SOURCE_A.subarray(0, SOURCE_IDENTITY_BLOCK_SIZE_BYTES), headers: { 'content-type': 'application/octet-stream' } });
		expect(retry.status()).toBe(200);
		expect(fixture.storageWrites).toBe(1);
		const attack = await request.put(endpoint, { data: SOURCE_B.subarray(0, SOURCE_IDENTITY_BLOCK_SIZE_BYTES), headers: { 'content-type': 'application/octet-stream' } });
		expect(attack.status()).toBe(409);
		expect((await attack.json()).error.details.reason).toBe('CHUNK_CONTENT_MISMATCH');
		expect(fixture.storageWrites).toBe(1);
		expect(fixture.objects.get(1)).toEqual(storedA);
	} finally {
		await fixture.app.close();
	}
});
