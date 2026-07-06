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

	it('rejects missing bodies and patches without supported fields', async () => {
		await expect(updateSettings(null)).rejects.toMatchObject({
			statusCode: 400,
		});
		await expect(updateSettings({ unknown: true })).rejects.toMatchObject({
			statusCode: 400,
		});
		expect(mocks.patchSettings).not.toHaveBeenCalled();
	});

	it('coerces numeric setting values and persists a valid patch', async () => {
		await expect(updateSettings({ maxGameFileMb: '4096', maxChunkSizeMb: '8' })).resolves.toEqual({
			maxGameFileMb: 5120,
			maxChunkSizeMb: 8,
		});

		expect(mocks.patchSettings).toHaveBeenCalledWith({
			maxGameFileMb: 4096,
			maxChunkSizeMb: 8,
		});
	});

	it.each([
		{ maxGameFileMb: 0 },
		{ maxGameFileMb: '1.5' },
		{ maxChunkSizeMb: 0 },
		{ maxChunkSizeMb: 'bad' },
	])('rejects invalid numeric setting patch %o', async (body) => {
		await expect(updateSettings(body)).rejects.toMatchObject({
			statusCode: 400,
		});
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
