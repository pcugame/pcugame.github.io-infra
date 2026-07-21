import { notFound } from '../../../shared/errors.js';
import type { BannedIpItem } from '@pcu/contracts';

export interface BannedIpServiceDependencies {
	repository: {
		findAllBannedIps(): Promise<Array<{
			id: number;
			ip: string;
			reason: string;
			createdAt: Date;
		}>>;
		findBannedIpById(id: number): Promise<{ id: number; ip: string } | null>;
		deleteBannedIp(id: number): Promise<unknown>;
	};
	banCache: {
		remove(ip: string): void;
	};
}

/** List all banned IPs mapped to API shape */
export async function listBannedIps(deps: BannedIpServiceDependencies): Promise<BannedIpItem[]> {
	const items = await deps.repository.findAllBannedIps();
	return items.map((b) => ({
		id: b.id,
		ip: b.ip,
		reason: b.reason,
		createdAt: b.createdAt.toISOString(),
	}));
}

/** Unban an IP by record ID. Removes from DB and in-memory cache. */
export async function unbanIp(deps: BannedIpServiceDependencies, id: number): Promise<void> {
	const record = await deps.repository.findBannedIpById(id);
	if (!record) throw notFound('Banned IP record not found');

	await deps.repository.deleteBannedIp(record.id);
	deps.banCache.remove(record.ip);
}

export function createBannedIpService(deps: BannedIpServiceDependencies) {
	return {
		listBannedIps: () => listBannedIps(deps),
		unbanIp: (id: number) => unbanIp(deps, id),
	};
}
