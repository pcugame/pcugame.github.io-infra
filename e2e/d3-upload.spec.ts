import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { test, expect } from '@playwright/test';
import {
	SOURCE_IDENTITY_ALGORITHM,
	SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
	sourceIdentityRoot,
} from '../apps/api/src/modules/admin/game-upload/source-identity.js';

const FILE_SIZE = SOURCE_IDENTITY_BLOCK_SIZE_BYTES * 2;
const API_ORIGIN = 'http://localhost:4000';
const STORAGE_ORIGIN = 'http://garage.test';
const SESSION_ID = 'd3-e2e-session';

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

function sessionStatus(parts: Array<{ partNumber: number; etag: string; sizeBytes: number }>, status = 'PENDING') {
	return {
		sessionId: SESSION_ID,
		projectId: 7,
		originalName: 'resume-a.zip',
		totalBytes: SOURCE_A.length,
		chunkSizeBytes: SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
		totalChunks: 2,
		uploadedCount: parts.length,
		parts,
		status,
		expiresAt: '2026-08-21T00:00:00.000Z',
		uploadKind: 'WEBGL',
		generation: 3,
		...IDENTITY_A,
	};
}

async function installResumeRoutes(page: import('@playwright/test').Page, uploadedPartNumbers: number[]) {
	const objects = new Map<number, Buffer>();
	if (uploadedPartNumbers.includes(1)) {
		objects.set(1, Buffer.from(SOURCE_A.subarray(0, SOURCE_IDENTITY_BLOCK_SIZE_BYTES)));
	}
	const putRequests: Buffer[] = [];
	let capabilityRequests = 0;
	let completionRequests = 0;
	const storedParts = () => [...objects.entries()].map(([partNumber, body]) => ({
		partNumber,
		etag: `\"garage-etag-${partNumber}\"`,
		sizeBytes: body.length,
	})).sort((a, b) => a.partNumber - b.partNumber);

	await page.route(`${STORAGE_ORIGIN}/**`, async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const match = /^\/multipart\/d3-e2e-session\/parts\/(\d+)$/.exec(url.pathname);
		if (request.method() !== 'PUT' || !match) {
			return route.fulfill({ status: 404 });
		}
		const partNumber = Number(match[1]);
		const body = request.postDataBuffer() ?? Buffer.alloc(0);
		const checksumSha256 = createHash('sha256').update(body).digest('base64');
		if (request.headers()['x-amz-checksum-sha256'] !== checksumSha256
			|| url.searchParams.get('generation') !== '3') {
			return route.fulfill({ status: 403 });
		}
		putRequests.push(Buffer.from(body));
		objects.set(partNumber, Buffer.from(body));
		return route.fulfill({
			status: 200,
			headers: {
				'access-control-allow-origin': 'http://127.0.0.1:4173',
				'access-control-expose-headers': 'ETag',
				etag: `\"garage-etag-${partNumber}\"`,
			},
		});
	});

	await page.route(`${API_ORIGIN}/**`, async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (request.method() === 'GET' && url.pathname === '/api/admin/projects/7/game-upload-sessions') {
			return route.fulfill({ json: { ok: true, data: { items: [sessionStatus(storedParts())] } } });
		}
		if (request.method() === 'GET' && url.pathname === `/api/admin/game-upload-sessions/${SESSION_ID}`) {
			return route.fulfill({
				json: {
					ok: true,
					data: sessionStatus(storedParts(), completionRequests > 0 ? 'COMPLETED' : 'PENDING'),
				},
			});
		}
		if (request.method() === 'POST' && url.pathname === `/api/admin/game-upload-sessions/${SESSION_ID}/part-urls`) {
			capabilityRequests++;
			const payload = request.postDataJSON() as {
				generation?: number;
				parts?: Array<{ partNumber: number; checksumSha256: string }>;
			};
			if (payload.generation !== 3 || !Array.isArray(payload.parts)) {
				return route.fulfill({ status: 400, json: { ok: false, error: { code: 'VALIDATION_ERROR' } } });
			}
			return route.fulfill({
				json: {
					ok: true,
					data: {
						generation: 3,
						expiresAt: '2026-08-20T00:05:00.000Z',
						parts: payload.parts.map(({ partNumber, checksumSha256 }) => ({
							partNumber,
							url: `${STORAGE_ORIGIN}/multipart/${SESSION_ID}/parts/${partNumber}?generation=3`,
							requiredHeaders: {
								'content-type': 'application/zip',
								'x-amz-checksum-sha256': checksumSha256,
							},
						})),
					},
				},
			});
		}
		if (request.method() === 'PUT' && /\/chunks\/\d+$/.test(url.pathname)) {
			return route.fulfill({ status: 404, json: { ok: false, error: { code: 'NOT_FOUND' } } });
		}
		if (request.method() === 'POST' && url.pathname === `/api/admin/game-upload-sessions/${SESSION_ID}/complete`) {
			completionRequests++;
			const data = completionRequests === 1
				? { status: 'VERIFYING', sessionId: SESSION_ID, generation: 3, sizeBytes: SOURCE_A.length }
				: {
					status: 'COMPLETED', sessionId: SESSION_ID, generation: 3,
					sizeBytes: SOURCE_A.length, uploadKind: 'WEBGL',
					webglUrl: 'https://public.example.test/webgl/opaque-deployment/index.html',
				};
			return route.fulfill({ json: { ok: true, data } });
		}
		return route.fulfill({ status: 500, json: { ok: false, error: { code: 'ERROR', message: 'Unexpected E2E request' } } });
	});
	return {
		objects,
		putRequests,
		get capabilityRequests() { return capabilityRequests; },
		get completionRequests() { return completionRequests; },
	};
}

function uploadFile(name: string, buffer: Buffer) {
	return { name, mimeType: 'application/zip', buffer };
}

test.beforeAll(() => {
	expect(SOURCE_A.length).toBe(SOURCE_B.length);
	expect(SOURCE_A.equals(SOURCE_B)).toBeFalsy();
	expect(IDENTITY_A.sourceIdentity).not.toBe(IDENTITY_B.sourceIdentity);
});

test('Scenario 1: the real Worker hashes A, resumes from Garage ListParts, and completes direct-only', async ({ page }) => {
	const fixture = await installResumeRoutes(page, [1]);
	await page.goto('/e2e/');
	await expect(page.getByText('미완료 업로드가 있습니다:')).toBeVisible();
	await page.locator('input[type="file"]').setInputFiles(uploadFile('resume-a.zip', SOURCE_A));
	await page.getByRole('button', { name: '이어올리기' }).click();
	await expect(page.getByText('업로드 완료', { exact: true })).toBeVisible();
	expect(fixture.putRequests).toHaveLength(1);
	expect(fixture.putRequests[0]).toEqual(SOURCE_A.subarray(SOURCE_IDENTITY_BLOCK_SIZE_BYTES));
	expect(fixture.objects.get(1)).toEqual(SOURCE_A.subarray(0, SOURCE_IDENTITY_BLOCK_SIZE_BYTES));
	expect(fixture.objects.get(2)).toEqual(SOURCE_A.subarray(SOURCE_IDENTITY_BLOCK_SIZE_BYTES));
	expect(fixture.capabilityRequests).toBe(1);
	expect(fixture.completionRequests).toBe(2);
});

test('Scenario 2: same-size B is rejected before any capability or direct PUT', async ({ page }) => {
	const fixture = await installResumeRoutes(page, [1]);
	const originalAChunk = Buffer.from(fixture.objects.get(1)!);
	await page.goto('/e2e/');
	await page.locator('input[type="file"]').setInputFiles(uploadFile('resume-b.zip', SOURCE_B));
	await page.getByRole('button', { name: '이어올리기' }).click();
	await expect(page.getByText('선택한 파일이 이 업로드 세션을 시작한 파일과 다릅니다. 원래 파일을 선택하거나 새 업로드를 시작하세요.')).toBeVisible();
	expect(fixture.putRequests).toHaveLength(0);
	expect(fixture.objects.get(1)).toEqual(originalAChunk);
	expect(fixture.capabilityRequests).toBe(0);
	expect(fixture.completionRequests).toBe(0);
});

test('Scenario 3 and 4: a checksum-bound data-plane URL is replay-safe and the old relay is absent', async ({ request }) => {
	const expectedBody = SOURCE_A.subarray(0, SOURCE_IDENTITY_BLOCK_SIZE_BYTES);
	const expectedChecksum = createHash('sha256').update(expectedBody).digest('base64');
	const objects = new Map<number, Buffer>();
	let storageWrites = 0;
	const server = createServer((incoming, response) => {
		if (incoming.method !== 'PUT' || incoming.url?.startsWith('/storage/upload-part/1?') !== true) {
			response.statusCode = 404;
			response.end();
			return;
		}
		const chunks: Buffer[] = [];
		incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
		incoming.on('end', () => {
			const body = Buffer.concat(chunks);
			const checksum = createHash('sha256').update(body).digest('base64');
			if (incoming.headers['x-amz-checksum-sha256'] !== expectedChecksum
				|| checksum !== expectedChecksum) {
				response.statusCode = 403;
				response.end();
				return;
			}
			storageWrites++;
			objects.set(1, body);
			response.statusCode = 200;
			response.setHeader('ETag', '"direct-etag-1"');
			response.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('storage test server did not bind');
	const origin = `http://127.0.0.1:${address.port}`;
	const endpoint = `${origin}/storage/upload-part/1?generation=3&expires=4102444800`;
	try {
		const headers = { 'content-type': 'application/zip', 'x-amz-checksum-sha256': expectedChecksum };
		const first = await request.put(endpoint, { data: expectedBody, headers });
		expect(first.status()).toBe(200);
		const retry = await request.put(endpoint, { data: expectedBody, headers });
		expect(retry.status()).toBe(200);
		const [concurrentA, concurrentB] = await Promise.all([
			request.put(endpoint, { data: expectedBody, headers }),
			request.put(endpoint, { data: expectedBody, headers }),
		]);
		expect([concurrentA.status(), concurrentB.status()]).toEqual([200, 200]);
		const attack = await request.put(endpoint, {
			data: SOURCE_B.subarray(0, SOURCE_IDENTITY_BLOCK_SIZE_BYTES),
			headers,
		});
		expect(attack.status()).toBe(403);
		expect(storageWrites).toBe(4);
		expect(objects.get(1)).toEqual(expectedBody);
		const removedRelay = await request.put(
			`${origin}/api/admin/game-upload-sessions/${SESSION_ID}/chunks/0`,
			{ data: expectedBody, headers: { 'content-type': 'application/octet-stream' } },
		);
		expect(removedRelay.status()).toBe(404);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
});
