import { badRequest, notFound } from '../../shared/errors.js';
import { publicObjectUrl, safePublicRelativePath } from '../../shared/public-origin.js';
import type { HttpResponseDescriptor } from '../../shared/response-descriptor.js';
import { parseWebglEntryKey } from '../webgl/paths.js';

interface PublicDeploymentRecord {
	id: string;
	publicBucket: string;
	publicPrefix: string;
	entryObjectKey: string;
	state: string;
}

export interface PublicDeliveryBridgeRepository {
	resolvePublicImageBridge(storageKey: string): Promise<{
		bucket: string;
		objectKey: string;
		usedLegacy: boolean;
	} | null>;
	findPublicWebglProject(id: number): Promise<{
		id: number;
		webglEntryKey: string;
		currentWebglDeploymentId: string | null;
		currentWebglDeployment: PublicDeploymentRecord | null;
	} | null>;
	recordMigrationMetric?(
		name: string,
		scope: string,
		details?: Record<string, unknown>,
	): Promise<void>;
}

function redirect(location: string): HttpResponseDescriptor {
	return {
		status: 307,
		headers: {
			Location: location,
			'Cache-Control': 'no-store',
			'Referrer-Policy': 'no-referrer',
		},
	};
}

export function createPublicDeliveryBridgeService(deps: {
	publicAssetOrigin: string;
	publicBucket: string;
	repository: PublicDeliveryBridgeRepository;
	logger: { warn(record: Record<string, unknown>, message: string): void };
}) {
	async function metric(name: string, scope: string, details: Record<string, unknown>) {
		await deps.repository.recordMigrationMetric?.(name, scope, details);
	}

	async function image(storageKey: string): Promise<HttpResponseDescriptor> {
		const resolved = await deps.repository.resolvePublicImageBridge(storageKey);
		if (!resolved) throw notFound('Image not found');
		if (resolved.bucket && resolved.bucket !== deps.publicBucket) throw notFound('Image not found');
		await metric('public_image_legacy_bridge', 'api-route', {
			usedLegacyLookup: resolved.usedLegacy,
		});
		if (resolved.usedLegacy) {
			deps.logger.warn({ storageKey }, 'Public image bridge used legacy identity fallback');
		}
		return redirect(publicObjectUrl(deps.publicAssetOrigin, resolved.objectKey));
	}

	async function webgl(
		projectId: number,
		requestedPath: string,
		rawUrl?: string,
	): Promise<HttpResponseDescriptor> {
		let relativePath: string;
		try {
			relativePath = safePublicRelativePath(requestedPath || 'index.html', rawUrl);
		} catch {
			throw badRequest('Invalid WebGL asset path');
		}
		const project = await deps.repository.findPublicWebglProject(projectId);
		if (!project) throw notFound('WebGL build not found');

		let objectKey: string;
		let usedLegacy = false;
		if (project.currentWebglDeploymentId !== null) {
			const deployment = project.currentWebglDeployment;
			if (!deployment || deployment.id !== project.currentWebglDeploymentId
				|| deployment.state !== 'READY' || deployment.publicBucket !== deps.publicBucket
				|| !deployment.publicPrefix.endsWith('/')
				|| !deployment.entryObjectKey.startsWith(deployment.publicPrefix)) {
				throw notFound('WebGL build not found');
			}
			objectKey = relativePath === 'index.html'
				? deployment.entryObjectKey
				: `${deployment.publicPrefix}${relativePath}`;
			if (!objectKey.startsWith(deployment.publicPrefix)) throw badRequest('Invalid WebGL asset path');
		} else {
			const legacy = parseWebglEntryKey(projectId, project.webglEntryKey);
			if (!legacy) throw notFound('WebGL build not found');
			objectKey = relativePath === 'index.html'
				? legacy.entryKey
				: `${legacy.sitePrefix}${relativePath}`;
			usedLegacy = true;
			await metric('public_webgl_legacy_fallback', 'api-route', { projectId });
			deps.logger.warn({ projectId }, 'Public WebGL bridge used legacy deployment fallback');
		}
		await metric('public_webgl_legacy_bridge', 'api-route', { projectId, usedLegacy });
		return redirect(publicObjectUrl(deps.publicAssetOrigin, objectKey));
	}

	return { image, webgl };
}

