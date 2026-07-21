import { env } from '../../../config/env.js';
import { createProjectSerializer } from './serializer.js';

let productionSerializer: ReturnType<typeof createProjectSerializer> | undefined;

function serializer() {
	productionSerializer ??= createProjectSerializer(env().API_PUBLIC_URL);
	return productionSerializer;
}

export const assetUrl: ReturnType<typeof createProjectSerializer>['assetUrl'] = (...args) => (
	serializer().assetUrl(...args)
);
export const serializeProjectDetail: ReturnType<typeof createProjectSerializer>['serializeProjectDetail'] = (...args) => (
	serializer().serializeProjectDetail(...args)
);
