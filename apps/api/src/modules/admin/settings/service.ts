import { badRequest } from '../../../shared/errors.js';
import type { SiteSettingsData, UpdateSiteSettingsRequest } from '@pcu/contracts';

export interface SettingsServiceDependencies {
	maxChunkSizeMb: number;
	repository: {
		getSettings(): Promise<SiteSettingsData>;
		patchSettings(patch: UpdateSiteSettingsRequest): Promise<SiteSettingsData>;
	};
}

export function createSettingsService(deps: SettingsServiceDependencies) {
	return {
		getSettings(): Promise<SiteSettingsData> {
			return deps.repository.getSettings();
		},

		/** Validate and apply a settings patch. */
		async updateSettings(body: Record<string, unknown> | null): Promise<SiteSettingsData> {
			if (!body) throw badRequest('Missing body');

			const patch: UpdateSiteSettingsRequest = {};

			if (body.maxGameFileMb !== undefined) {
				const v = Number(body.maxGameFileMb);
				if (!Number.isInteger(v) || v < 1) throw badRequest('maxGameFileMb must be a positive integer');
				patch.maxGameFileMb = v;
			}

			if (body.maxChunkSizeMb !== undefined) {
				const v = Number(body.maxChunkSizeMb);
				if (!Number.isInteger(v) || v < 1 || v > deps.maxChunkSizeMb) {
					throw badRequest(`maxChunkSizeMb must be 1-${deps.maxChunkSizeMb}`);
				}
				patch.maxChunkSizeMb = v;
			}

			if (Object.keys(patch).length === 0) throw badRequest('No valid fields to update');

			return deps.repository.patchSettings(patch);
		},
	};
}
