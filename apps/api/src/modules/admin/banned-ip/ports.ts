import type { DownloadRateLimitResult } from '../../../shared/download-rate-limit.js';
import type { BannedIpSource } from '@pcu/contracts';
export type BanMutationQueue = <T>(operation: () => Promise<T>) => Promise<T>;
export interface AutomaticBanRepository {
 upsertBannedIp(ip: string, reason: string): Promise<{ disabledAt: Date | null }>;
}
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
	mutateBan?: BanMutationQueue;
	repository: {
		findAllBannedIps(): Promise<BannedIpRecord[]>;
		findBannedIpById(id: number): Promise<{ id: number; ip: string } | null>;
		createManualBan(ip: string, reason: string, autoIpBanEnabled?: boolean): Promise<BannedIpRecord>;
		deactivateBan(id: number): Promise<unknown>;
	};
	banCache: {
		add(ip: string): void;
		remove(ip: string): void;
	};
}


export interface BannedIpStartupGate {
	warm(ips: string[]): void;
	add(ip: string): void;
	remove(ip: string): void;
	check(ip: string, principalScope?: string): DownloadRateLimitResult;
	isReady(): boolean;
}
