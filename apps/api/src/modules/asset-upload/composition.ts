import type { FastifyPluginAsync } from 'fastify';
import { createAssetUploadController, createUnavailableAssetUploadController } from './controller.js';
import { createAssetUploadService } from './service.js';
import type { AssetUploadRepository, DirectMultipartControlStorage, DirectPartSigner } from './ports.js';

/** Pure control-plane graph. BackendContext must register this separately. */
export function createAssetUploadControlGraph(deps: Parameters<typeof createAssetUploadService>[0]): { controller: FastifyPluginAsync; service: ReturnType<typeof createAssetUploadService> } {
	const service = createAssetUploadService(deps);
	return { service, controller: createAssetUploadController({ service }) };
}

/** Route-complete fail-closed graph used only for injected non-Prisma seams. */
export function createUnavailableAssetUploadControlGraph(): { controller: FastifyPluginAsync } {
	return { controller: createUnavailableAssetUploadController() };
}

export type AssetUploadControlGraphDependencies = {
	repository: AssetUploadRepository;
	storage: DirectMultipartControlStorage;
	partSigner: DirectPartSigner;
};
