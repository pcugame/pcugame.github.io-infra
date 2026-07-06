import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	findAllBannedIps: vi.fn(),
	findBannedIpById: vi.fn(),
	deleteBannedIp: vi.fn(),
	removeBan: vi.fn(),
}));

vi.mock('../shared/protected-download-limiter.js', () => ({
	protectedDownloadLimiter: {
		removeBan: mocks.removeBan,
	},
}));

vi.mock('../modules/admin/banned-ip/repository.js', () => ({
	findAllBannedIps: mocks.findAllBannedIps,
	findBannedIpById: mocks.findBannedIpById,
	deleteBannedIp: mocks.deleteBannedIp,
}));

import { listBannedIps, unbanIp } from '../modules/admin/banned-ip/service.js';

describe('banned IP service', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('serializes banned IP records for the admin API', async () => {
		mocks.findAllBannedIps.mockResolvedValue([
			{
				id: 1,
				ip: '203.0.113.10',
				reason: 'Rate limit exceeded',
				createdAt: new Date('2026-01-02T03:04:05.000Z'),
			},
		]);

		await expect(listBannedIps()).resolves.toEqual([
			{
				id: 1,
				ip: '203.0.113.10',
				reason: 'Rate limit exceeded',
				createdAt: '2026-01-02T03:04:05.000Z',
			},
		]);
	});

	it('deletes the DB record and removes the IP from the in-memory limiter cache', async () => {
		mocks.findBannedIpById.mockResolvedValue({
			id: 7,
			ip: '203.0.113.20',
		});

		await unbanIp(7);

		expect(mocks.deleteBannedIp).toHaveBeenCalledWith(7);
		expect(mocks.removeBan).toHaveBeenCalledWith('203.0.113.20');
	});

	it('throws 404 when the banned IP record does not exist', async () => {
		mocks.findBannedIpById.mockResolvedValue(null);

		await expect(unbanIp(404)).rejects.toMatchObject({
			statusCode: 404,
			code: 'NOT_FOUND',
		});
		expect(mocks.deleteBannedIp).not.toHaveBeenCalled();
		expect(mocks.removeBan).not.toHaveBeenCalled();
	});
});
