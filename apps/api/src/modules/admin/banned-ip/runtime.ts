import { AppError, forbidden } from '../../../shared/errors.js';
import type { DownloadRateLimitResult } from '../../../shared/download-rate-limit.js';
import type { BanMutationQueue, AutomaticBanRepository, BannedIpStartupGate, BannedIpServiceDependencies } from './ports.js';
import { isBanActive } from './policy.js';
/**
 * Protected downloads fail closed until the context-owned startup warmup has
 * atomically installed the DB snapshot. A constructed/registered app can never
 * interpret an uninitialized empty set as "no banned IPs".
 */
export function createBannedIpStartupGate(limiter: {
	loadBannedIps(ips: string[]): void;
	addBan(ip: string): void;
	removeBan(ip: string): void;
	check(ip: string, principalScope?: string): DownloadRateLimitResult;
}): BannedIpStartupGate {
	let ready = false;
	return {
		warm(ips) {
			limiter.loadBannedIps(ips);
			ready = true;
		},
		add: (ip) => limiter.addBan(ip),
		remove: (ip) => limiter.removeBan(ip),
		check(ip, principalScope) {
			if (!ready) {
				throw new AppError(
					503,
					'Protected downloads are unavailable until the banned-IP cache is ready.',
					'BANNED_IP_CACHE_UNAVAILABLE',
				);
			}
			return limiter.check(ip, principalScope);
		},
		isReady: () => ready,
	};
}

/** Explicit startup owner. A DB failure is fatal and remains rejected. */
export function createBannedIpWarmup(deps: {
	repository: Pick<BannedIpServiceDependencies['repository'], 'findAllBannedIps'>;
	autoIpBanEnabled?: boolean;
	gate: Pick<BannedIpStartupGate, 'warm'>;
	logger: { info(value: unknown, message?: string): void; error(value: unknown, message?: string): void };
}): { start(): Promise<void> } {
	let startPromise: Promise<void> | undefined;
	return {
		start() {
			startPromise ??= (async () => {
				try {
					const banned = (await deps.repository.findAllBannedIps()).filter((row) => isBanActive(row, deps.autoIpBanEnabled ?? false));
					deps.gate.warm(banned.map(({ ip }) => ip));
					deps.logger.info({ count: banned.length }, 'Loaded banned IP cache');
				} catch (error) {
					deps.logger.error(error, 'Banned IP cache warmup failed; aborting startup');
					throw error;
				}
			})();
			return startPromise;
		},
	};
}


export function createDownloadRestriction(deps: {
 gate: BannedIpStartupGate;
 repository: AutomaticBanRepository;
 mutateBan: BanMutationQueue;
}) {
 return async (ip: string, principalScope: string): Promise<void> => {
  const result = deps.gate.check(ip, principalScope);
  if (result.status === 'rate_limited') throw new AppError(429, 'Too many protected download requests. Try again later.', 'RATE_LIMITED', { retryAfterSec: result.retryAfterSec });
  if (result.status === 'abuse_ceiling') {
   await deps.mutateBan(async () => {
    const record = await deps.repository.upsertBannedIp(ip, 'Protected download IP abuse ceiling exceeded');
    if (record.disabledAt !== null) throw new AppError(429, 'Too many protected download requests. Try again later.', 'RATE_LIMITED');
    deps.gate.add(ip);
   });
   throw forbidden('Your IP has been blocked due to excessive download requests. Contact an administrator.');
  }
 };
}
