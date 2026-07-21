import { env } from '../../../config/env.js';
import { cachedSettingsStore } from '../../../infrastructure/production-ports.js';
import { createSettingsService } from './service.js';

let productionService: ReturnType<typeof createSettingsService> | undefined;

function service() {
	productionService ??= createSettingsService({
		maxChunkSizeMb: Math.floor(env().UPLOAD_CHUNK_SIZE_MB),
		repository: {
			getSettings: () => cachedSettingsStore.get(),
			patchSettings: (patch) => cachedSettingsStore.update(patch),
		},
	});
	return productionService;
}

export const settingsService = {
	getSettings: () => service().getSettings(),
	updateSettings: (...args: Parameters<ReturnType<typeof service>['updateSettings']>) => (
		service().updateSettings(...args)
	),
};
