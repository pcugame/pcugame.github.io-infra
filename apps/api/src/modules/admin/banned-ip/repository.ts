import type { PrismaClient } from '../../../generated/prisma/client.js';
import { normalizeIpTarget } from '@pcu/contracts';
import { isBanActive } from './policy.js';
import { conflict } from '../../../shared/errors.js';

export function createBannedIpRepository(client: PrismaClient) {
	return {
		/** Upsert a banned IP record */
		async upsertBannedIp(ip: string, reason: string) {
			// Historical mapped/expanded addresses may not use canonical storage.
			// Never recreate an automatic ban for an equivalent deactivated target.
			const disabled = await client.bannedIp.findMany({ where: { disabledAt: { not: null } } });
			for (const record of disabled) {
				try { if (normalizeIpTarget(record.ip) === ip) return record; } catch { /* Unrelated legacy input. */ }
			}
			return client.bannedIp.upsert({
				where: { ip },
				create: { ip, reason, source: 'AUTO' },
				update: {},
			});
		},

		findAllBannedIps: () => client.bannedIp.findMany({ orderBy: { createdAt: 'desc' } }),
		findBannedIpById: (id: number) => client.bannedIp.findUnique({ where: { id } }),
		async createManualBan(ip: string, reason: string, autoIpBanEnabled = false) {
			return client.$transaction(async (tx) => {
				// Old IPv6/mapped records may predate canonical storage.
				const records = await tx.bannedIp.findMany();
				let inactiveId: number | undefined;
				for (const record of records) {
					let canonical: string;
					try { canonical = normalizeIpTarget(record.ip); } catch { continue; }
					if (canonical === ip && isBanActive(record, autoIpBanEnabled)) {
						throw conflict('This IP address or range is already blocked');
					}
					if (canonical === ip && (inactiveId === undefined || record.ip === ip)) inactiveId = record.id;
				}
				// Conditional update and unique constraint make concurrent registration atomic.
				const reactivated = await tx.bannedIp.updateMany({
					where: { ...(inactiveId ? { id: inactiveId } : { ip }), OR: [{ disabledAt: { not: null } }, ...(!autoIpBanEnabled ? [{ source: 'AUTO' as const }] : [])] },
					data: { ip, source: 'MANUAL', reason, disabledAt: null },
				});
				if (reactivated.count) return tx.bannedIp.findUniqueOrThrow({ where: { ip } });
				if (await tx.bannedIp.findUnique({ where: { ip } })) throw conflict('This IP address or range is already blocked');
				return tx.bannedIp.create({ data: { ip, reason, source: 'MANUAL' } });
			});
		},
		deactivateBan: (id: number) => client.bannedIp.update({ where: { id }, data: { disabledAt: new Date() } }),
	};
}
