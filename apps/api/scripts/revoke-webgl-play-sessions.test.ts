import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { revokeOptions, revokePlaySessions } from './revoke-webgl-play-sessions.js';
describe('operator play session revocation', () => {
	it('requires one explicit scope and defaults to a read-only count', async () => {
		for (const args of [[], ['--apply'], ['--all', '--external'], ['--all', '--all'], ['--all', '--unknown']]) expect(() => revokeOptions(args)).toThrow();
		const count = vi.fn(async () => 3), updateMany = vi.fn();
		const client = { webglPlaySession: { count, updateMany } } as unknown as Pick<PrismaClient, 'webglPlaySession'>;
		expect(await revokePlaySessions(client, revokeOptions(['--external']))).toEqual({ mode: 'dry-run', scope: 'external', count: 3 });
		expect(count).toHaveBeenCalledWith({ where: { revokedAt: null, approvedOrigins: { isEmpty: false } } });
		expect(updateMany).not.toHaveBeenCalled();
	});
	it('applies a durable revocation without deleting audit or revealing credentials', async () => {
		const updateMany = vi.fn(async () => ({ count: 2 })), at = new Date('2026-10-01T00:00:00Z');
		const client = { webglPlaySession: { updateMany } } as unknown as Pick<PrismaClient, 'webglPlaySession'>;
		expect(await revokePlaySessions(client, revokeOptions(['--all', '--apply']), at)).toEqual({ mode: 'applied', scope: 'all', count: 2 });
		expect(updateMany).toHaveBeenCalledWith({ where: { revokedAt: null }, data: { revokedAt: at } });
	});
});
