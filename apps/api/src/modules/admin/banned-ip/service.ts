import { createBanMutationQueue } from '../../../shared/ban-mutation-queue.js';
import { badRequest, conflict, isUniqueConstraintError, notFound } from '../../../shared/errors.js';
import { normalizeIpTarget, type BannedIpItem, type BannedIpSource, type CreateBannedIpRequest } from '@pcu/contracts';

export interface BannedIpRecord {
	id: number;
	ip: string;
	reason: string;
	createdAt: Date;
	source: BannedIpSource;
	disabledAt: Date | null;
}

export interface BannedIpServiceDependencies {
	autoIpBanEnabled?: boolean;
	mutateBan?: ReturnType<typeof createBanMutationQueue>;
	repository: {
		findAllBannedIps(): Promise<BannedIpRecord[]>;
		findBannedIpById(id: number): Promise<{ id: number; ip: string } | null>;
		createManualBan(ip: string, reason: string, autoIpBanEnabled?: boolean): Promise<BannedIpRecord>;
		deleteBannedIp(id: number): Promise<unknown>;
	};
	banCache: {
		add(ip: string): void;
		remove(ip: string): void;
	};
}

function serialize(record: BannedIpRecord, autoEnabled: boolean): BannedIpItem {
	return {
		id: record.id, ip: record.ip, reason: record.reason,
		createdAt: record.createdAt.toISOString(), source: record.source,
		disabledAt: record.disabledAt?.toISOString() ?? null,
		active: record.disabledAt === null && (record.source !== 'AUTO' || autoEnabled),
	};
}

export async function listBannedIps(deps: BannedIpServiceDependencies): Promise<BannedIpItem[]> {
	return (await deps.repository.findAllBannedIps()).map((record) => serialize(record, deps.autoIpBanEnabled ?? false));
}

export async function registerBannedIp(deps: BannedIpServiceDependencies, input: CreateBannedIpRequest): Promise<BannedIpItem> {
	let ip: string;
	try { ip = normalizeIpTarget(input.ip); } catch { throw badRequest('Invalid IP address or CIDR', 'VALIDATION_ERROR'); }
	const reason = input.reason.trim();
	if (!reason || reason.length > 1000) throw badRequest('A reason of 1–1000 characters is required', 'VALIDATION_ERROR');
	let record: BannedIpRecord;
	try {
		record = await deps.repository.createManualBan(ip, reason, deps.autoIpBanEnabled ?? false);
	} catch (error) {
		if (isUniqueConstraintError(error)) throw conflict('This IP address or range is already blocked');
		throw error;
	}
	deps.banCache.add(record.ip);
	return serialize(record, deps.autoIpBanEnabled ?? false);
}

/** Preserve the record as history; cache changes follow the successful DB write. */
export async function unbanIp(deps: BannedIpServiceDependencies, id: number): Promise<void> {
	const record = await deps.repository.findBannedIpById(id);
	if (!record) throw notFound('Banned IP record not found');
	await deps.repository.deleteBannedIp(record.id);
	deps.banCache.remove(record.ip);
}

export function createBannedIpService(deps: BannedIpServiceDependencies) {
	const mutate = deps.mutateBan ?? createBanMutationQueue();
	return {
		listBannedIps: () => listBannedIps(deps),
		registerBannedIp: (input: CreateBannedIpRequest) => mutate(() => registerBannedIp(deps, input)),
		unbanIp: (id: number) => mutate(() => unbanIp(deps, id)),
	};
}
