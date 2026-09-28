import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProtectedDownloadLimiter } from '../shared/protected-download-limiter.js';
import { createBannedIpService } from '../modules/admin/banned-ip/service.js';

const mocks = {
	findAllBannedIps: vi.fn(),
	findBannedIpById: vi.fn(),
	deleteBannedIp: vi.fn(),
	createManualBan: vi.fn(),
	removeBan: vi.fn(),
};

const service = createBannedIpService({
	repository: {
		findAllBannedIps: mocks.findAllBannedIps,
		findBannedIpById: mocks.findBannedIpById,
		deleteBannedIp: mocks.deleteBannedIp,
		createManualBan: mocks.createManualBan,
	},
	banCache: { add: vi.fn(), remove: mocks.removeBan },
});

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
				source: 'LEGACY',
				disabledAt: null,
				createdAt: new Date('2026-01-02T03:04:05.000Z'),
			},
		]);

		await expect(service.listBannedIps()).resolves.toEqual([
			{
				id: 1,
				ip: '203.0.113.10',
				reason: 'Rate limit exceeded',
				source: 'LEGACY',
				disabledAt: null,
				createdAt: '2026-01-02T03:04:05.000Z',
				active: true,
			},
		]);
	});

	it('deletes the DB record and removes the IP from the in-memory limiter cache', async () => {
		mocks.findBannedIpById.mockResolvedValue({
			id: 7,
			ip: '203.0.113.20',
		});

		await service.unbanIp(7);

		expect(mocks.deleteBannedIp).toHaveBeenCalledWith(7);
		expect(mocks.removeBan).toHaveBeenCalledWith('203.0.113.20');
	});

	it('serializes delayed unban and re-registration through the DB and cache updates', async () => {
		const limiter = createProtectedDownloadLimiter();
		limiter.addBan('192.0.2.1');
		const row = { id: 1, ip: '192.0.2.1', reason: 'test', source: 'MANUAL' as const, disabledAt: null as Date | null, createdAt: new Date() };
		let resolveDelete!: () => void;
		let signalDelete!: () => void;
		const deleteStarted = new Promise<void>((resolve) => { signalDelete = resolve; });
		const deleteResponse = new Promise<void>((resolve) => { resolveDelete = resolve; });
		const create = vi.fn(async () => { row.disabledAt = null; return row; });
		const isolated = createBannedIpService({
			repository: {
				findAllBannedIps: async () => [row], findBannedIpById: async () => row,
				createManualBan: create,
				deleteBannedIp: async () => { row.disabledAt = new Date(); signalDelete(); await deleteResponse; },
			}, banCache: { add: (ip) => limiter.addBan(ip), remove: (ip) => limiter.removeBan(ip) },
		});
		try {
			const unban = isolated.unbanIp(1);
			await deleteStarted;
			const register = isolated.registerBannedIp({ ip: '192.0.2.1', reason: 'new' });
			await Promise.resolve();
			expect(create).not.toHaveBeenCalled();
			resolveDelete();
			await Promise.all([unban, register]);
			expect(row.disabledAt).toBeNull();
			expect(limiter.isBanned('192.0.2.1')).toBe(true);
		} finally { limiter.close(); }
	});

	it('throws 404 when the banned IP record does not exist', async () => {
		mocks.findBannedIpById.mockResolvedValue(null);

		await expect(service.unbanIp(404)).rejects.toMatchObject({
			statusCode: 404,
			code: 'NOT_FOUND',
		});
		expect(mocks.deleteBannedIp).not.toHaveBeenCalled();
		expect(mocks.removeBan).not.toHaveBeenCalled();
	});
});
