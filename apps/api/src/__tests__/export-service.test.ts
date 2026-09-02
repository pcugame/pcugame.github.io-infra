import { describe, expect, it, vi } from 'vitest';
import { createExportService } from '../modules/admin/export/service.js';

describe('export job control service', () => {
	it('creates durable queued jobs without a storage or filesystem dependency', async () => {
		const repository = {
			createJob: vi.fn(async ({ id }: { id: string }) => ({ id })),
			latestJob: vi.fn(),
		};
		const service = createExportService({ repository, ids: { next: () => 'export-job-1' } });

		await expect(service.createJob({ requestedById: 7, year: 2026, dryRun: true }))
			.resolves.toEqual({ id: 'export-job-1' });
		expect(repository.createJob).toHaveBeenCalledWith({
			id: 'export-job-1', requestedById: 7, year: 2026, dryRun: true,
		});
	});

	it('uses a null year and false dry-run by default, and only reads durable status', async () => {
		const status = { id: 'job', state: 'READY' as const, progress: null, result: null, error: null };
		const repository = {
			createJob: vi.fn(async ({ id }: { id: string }) => ({ id })),
			latestJob: vi.fn(async () => status),
		};
		const service = createExportService({ repository, ids: { next: () => 'job' } });

		await service.createJob({ requestedById: 3 });
		expect(repository.createJob).toHaveBeenCalledWith({ id: 'job', requestedById: 3, year: null, dryRun: false });
		await expect(service.latestJob()).resolves.toEqual(status);
	});
});
