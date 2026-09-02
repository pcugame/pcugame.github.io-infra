import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('canonical direct GAME architecture boundary', () => {
	it('keeps object-body reads out of the Fastify control-plane modules', async () => {
		const [service, controller, composition] = await Promise.all([
			readFile(resolve(root, 'modules/asset-upload/service.ts'), 'utf8'),
			readFile(resolve(root, 'modules/asset-upload/controller.ts'), 'utf8'),
			readFile(resolve(root, 'modules/asset-upload/composition.ts'), 'utf8'),
		]);
		for (const source of [service, controller, composition]) {
			expect(source).not.toMatch(/\.stream\(|GetObject|uploadPart\s*\(/);
		}
	});

	it('places the sole GAME object stream capability in worker composition', async () => {
		const source = await readFile(resolve(root, 'modules/asset-upload/validation-worker.composition.ts'), 'utf8');
		expect(source).toContain("Pick<ObjectStorage, 'stream'>");
		expect(source).not.toMatch(/fastify|Fastify/i);
	});

	it('registers direct controls without importing GAME/WebGL/VIDEO processors into Fastify', async () => {
		const [backend, webglWorker, videoWorker] = await Promise.all([
			readFile(resolve(root, 'backend-context.ts'), 'utf8'),
			readFile(resolve(root, 'webgl-worker.ts'), 'utf8'),
			readFile(resolve(root, 'video-worker.ts'), 'utf8'),
		]);
		expect(backend).toContain('createAssetUploadControlGraph');
		expect(backend).not.toMatch(/validation-worker\.composition|webgl\/processing|modules\/video/);
		expect(webglWorker).toContain('createWebglProcessingGraph');
		expect(webglWorker).not.toMatch(/fastify|Fastify/i);
		expect(videoWorker).toContain('createVideoWorkerGraph');
		expect(videoWorker).not.toMatch(/fastify|Fastify/i);
	});
});
