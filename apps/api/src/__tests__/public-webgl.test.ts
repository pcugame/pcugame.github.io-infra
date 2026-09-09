import { describe, expect, it, vi } from 'vitest';
import { createPublicDeliveryBridgeService } from '../modules/public/delivery-bridge.service.js';

const deploymentId = '123e4567-e89b-42d3-a456-426614174000';
const publicPrefix = `public/webgl/7/${deploymentId}/`;

describe('public WebGL direct-origin bridge', () => {
	it('maps the current immutable deployment to a byte-free 307 capability', async () => {
		const findPublicWebglProject = vi.fn(async () => ({
			id: 7,
			webglEntryKey: 'legacy/webgl/7/ignored/index.html',
			currentWebglDeploymentId: deploymentId,
			currentWebglDeployment: {
				id: deploymentId,
				publicBucket: 'pcu-public',
				publicPrefix,
				entryObjectKey: `${publicPrefix}index.html`,
				state: 'READY',
			},
		}));
		const service = createPublicDeliveryBridgeService({
			publicAssetOrigin: 'https://assets.example.test',
			publicBucket: 'pcu-public',
			logger: { warn: vi.fn() },
			repository: { resolvePublicImageBridge: vi.fn(), findPublicWebglProject },
		});

		const response = await service.webgl(7, 'Build/game.wasm.br');
		expect(response).toEqual({
			status: 307,
			headers: {
				Location: `https://assets.example.test/${publicPrefix}Build/game.wasm.br`,
				'Cache-Control': 'no-store',
				'Referrer-Policy': 'no-referrer',
			},
		});
		expect(response).not.toHaveProperty('body');
		expect(findPublicWebglProject).toHaveBeenCalledWith(7);
	});

	it('uses the immutable deployment entry for the project root and rejects traversal before lookup', async () => {
		const findPublicWebglProject = vi.fn(async () => ({
			id: 7,
			webglEntryKey: 'legacy/webgl/7/ignored/index.html',
			currentWebglDeploymentId: deploymentId,
			currentWebglDeployment: {
				id: deploymentId,
				publicBucket: 'pcu-public',
				publicPrefix,
				entryObjectKey: `${publicPrefix}index.html`,
				state: 'READY',
			},
		}));
		const service = createPublicDeliveryBridgeService({
			publicAssetOrigin: 'https://assets.example.test',
			publicBucket: 'pcu-public',
			logger: { warn: vi.fn() },
			repository: { resolvePublicImageBridge: vi.fn(), findPublicWebglProject },
		});

		await expect(service.webgl(7, 'index.html')).resolves.toMatchObject({
			status: 307,
			headers: { Location: `https://assets.example.test/${publicPrefix}index.html` },
		});
		findPublicWebglProject.mockClear();
		await expect(service.webgl(7, '../private.wasm')).rejects.toMatchObject({
			statusCode: 400,
		});
		expect(findPublicWebglProject).not.toHaveBeenCalled();
	});

	it('retains a Phase-1 legacy deployment bridge with telemetry but never a storage body', async () => {
		const recordMigrationMetric = vi.fn(async () => undefined);
		const logger = { warn: vi.fn() };
		const service = createPublicDeliveryBridgeService({
			publicAssetOrigin: 'https://assets.example.test',
			publicBucket: 'pcu-public',
			logger,
			repository: {
				resolvePublicImageBridge: vi.fn(),
				findPublicWebglProject: vi.fn(async () => ({
					id: 7,
					webglEntryKey: `webgl/7/${deploymentId}/site/index.html`,
					currentWebglDeploymentId: null,
					currentWebglDeployment: null,
				})),
				recordMigrationMetric,
			},
		});

		const response = await service.webgl(7, 'Build/game.data');
		expect(response.status).toBe(307);
		expect(response.headers?.Location).toBe(
			`https://assets.example.test/webgl/7/${deploymentId}/site/Build/game.data`,
		);
		expect(response).not.toHaveProperty('body');
		expect(recordMigrationMetric).toHaveBeenCalledWith(
			'public_webgl_legacy_fallback', 'api-route', { projectId: 7 },
		);
		expect(logger.warn).toHaveBeenCalledOnce();
	});
});
