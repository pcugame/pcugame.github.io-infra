import { env } from '../../../config/env.js';
import { legacySiteSettingsStore } from '../../../shared/site-settings.runtime.js';
import { createSettingsService } from './service.js';

let productionService: ReturnType<typeof createSettingsService> | undefined;

function service() {
	productionService ??= createSettingsService({
		maxChunkSizeMb: Math.floor(env().UPLOAD_CHUNK_SIZE_MB),
		repository: {
			getSettings: () => legacySiteSettingsStore.get(),
			patchSettings: (patch) => legacySiteSettingsStore.update(patch),
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
