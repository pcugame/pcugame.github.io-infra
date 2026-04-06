import { notFound } from '../../../shared/errors.js';
import { gameDownloadLimiter } from '../../../shared/game-download-limiter.js';
import * as repo from './repository.js';

/** List all banned IPs mapped to API shape */
export async function listBannedIps() {
	const items = await repo.findAllBannedIps();
	return items.map((b) => ({
		id: b.id,
		ip: b.ip,
		reason: b.reason,
		createdAt: b.createdAt.toISOString(),
	}));
}

/** Unban an IP by record ID. Removes from DB and in-memory cache. */
export async function unbanIp(id: number) {
	const record = await repo.findBannedIpById(id);
	if (!record) throw notFound('Banned IP record not found');

	await repo.deleteBannedIp(record.id);
	gameDownloadLimiter.removeBan(record.ip);
}
