import { badRequest } from '../../../shared/errors.js';
import * as repo from './repository.js';

/** Get current site settings */
export function getSettings() {
	return repo.getSettings();
}

/** Validate and apply a settings patch */
export async function updateSettings(body: Record<string, unknown> | null) {
	if (!body) throw badRequest('Missing body');

	const patch: { maxGameFileMb?: number; maxChunkSizeMb?: number } = {};

	if (body.maxGameFileMb !== undefined) {
		const v = Number(body.maxGameFileMb);
		if (!Number.isInteger(v) || v < 1) throw badRequest('maxGameFileMb must be a positive integer');
		patch.maxGameFileMb = v;
	}

	if (body.maxChunkSizeMb !== undefined) {
		const v = Number(body.maxChunkSizeMb);
		if (!Number.isInteger(v) || v < 1 || v > 100) throw badRequest('maxChunkSizeMb must be 1–100');
		patch.maxChunkSizeMb = v;
	}

	if (Object.keys(patch).length === 0) throw badRequest('No valid fields to update');

	return repo.patchSettings(patch);
}
