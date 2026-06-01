import { badRequest } from '../../../shared/errors.js';
import type { SiteSettingsData, UpdateSiteSettingsRequest } from '@pcu/contracts';
import { env } from '../../../config/env.js';
import * as repo from './repository.js';

/** Get current site settings */
export function getSettings(): Promise<SiteSettingsData> {
	return repo.getSettings();
}

/** Validate and apply a settings patch */
export async function updateSettings(body: Record<string, unknown> | null): Promise<SiteSettingsData> {
	if (!body) throw badRequest('Missing body');

	const patch: UpdateSiteSettingsRequest = {};

	if (body.maxGameFileMb !== undefined) {
		const v = Number(body.maxGameFileMb);
		if (!Number.isInteger(v) || v < 1) throw badRequest('maxGameFileMb must be a positive integer');
		patch.maxGameFileMb = v;
	}

	if (body.maxChunkSizeMb !== undefined) {
		const v = Number(body.maxChunkSizeMb);
		const maxChunkSizeMb = Math.floor(env().UPLOAD_CHUNK_SIZE_MB);
		if (!Number.isInteger(v) || v < 1 || v > maxChunkSizeMb) {
			throw badRequest(`maxChunkSizeMb must be 1-${maxChunkSizeMb}`);
		}
		patch.maxChunkSizeMb = v;
	}

	if (Object.keys(patch).length === 0) throw badRequest('No valid fields to update');

	return repo.patchSettings(patch);
}
