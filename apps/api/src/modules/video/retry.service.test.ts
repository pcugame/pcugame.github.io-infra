import { describe, expect, it, vi } from 'vitest';
import { createVideoRetryService, type VideoRetryRepository } from './retry.service.js';

describe('administrator video retry policy', () => {
	it('checks the current persisted role even for direct service calls', async () => {
		const enqueue = vi.fn(async () => true);
		const repository: VideoRetryRepository = { retry: async (_actor, _project, _asset, run) => run('USER', enqueue) };
		await expect(createVideoRetryService(repository).retry(1, 2, 3)).rejects.toMatchObject({ statusCode: 403 });
		expect(enqueue).not.toHaveBeenCalled();
	});
	it('reports a conflict instead of claiming an unfenced retry succeeded', async () => {
		const repository: VideoRetryRepository = { retry: async (_actor, _project, _asset, run) => run('ADMIN', async () => false) };
		await expect(createVideoRetryService(repository).retry(1, 2, 3)).rejects.toMatchObject({ statusCode: 409 });
	});
});
