import { env } from '../../config/env.js';
import { getObjectStream, headObject } from '../../lib/storage.js';
import * as repository from './repository.js';
import { createPublicWebglService } from './webgl.service.js';

let productionService: ReturnType<typeof createPublicWebglService> | undefined;

function service() {
	if (productionService) return productionService;
	const config = env();
	productionService = createPublicWebglService({
		config: {
			apiPublicUrl: config.API_PUBLIC_URL,
			webPublicUrl: config.WEB_PUBLIC_URL,
			publicBucket: config.S3_BUCKET_PUBLIC,
		},
		repository,
		storage: {
			head: headObject,
			stream: getObjectStream,
		},
	});
	return productionService;
}

export const publicWebglService = {
	securityHeaders: () => service().securityHeaders(),
	preflight: () => service().preflight(),
	stream: (...args: Parameters<ReturnType<typeof service>['stream']>) => service().stream(...args),
};
