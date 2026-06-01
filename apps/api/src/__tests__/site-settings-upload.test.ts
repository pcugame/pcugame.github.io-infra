import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultTestEnv } from './helpers/app-mocks.js';

const mocks = vi.hoisted(() => ({
	getSettings: vi.fn(),
	patchSettings: vi.fn(),
}));

vi.mock('../config/env.js', () => ({
	env: () => ({ ...defaultTestEnv, UPLOAD_CHUNK_SIZE_MB: 10 }),
	loadEnv: () => ({ ...defaultTestEnv, UPLOAD_CHUNK_SIZE_MB: 10 }),
}));

vi.mock('../modules/admin/settings/repository.js', () => ({
	getSettings: mocks.getSettings,
	patchSettings: mocks.patchSettings,
}));

import { updateSettings } from '../modules/admin/settings/service.js';

describe('site settings upload limits', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.patchSettings.mockImplementation(async (patch) => ({
			maxGameFileMb: 5120,
			maxChunkSizeMb: patch.maxChunkSizeMb ?? 10,
		}));
	});

	it('keeps maxChunkSizeMb aligned with the chunk upload route body limit', async () => {
		await expect(updateSettings({ maxChunkSizeMb: 11 })).rejects.toMatchObject({
			statusCode: 400,
		});

		await expect(updateSettings({ maxChunkSizeMb: 10 })).resolves.toMatchObject({
			maxChunkSizeMb: 10,
		});
	});
});
