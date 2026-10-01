import type { ExternalLinkService } from '@pcu/contracts';
import { AppError } from '../../shared/errors.js';
import { resolveExternalLinkService, type ResolveExternalLink } from './resolver.js';

/** Process-local bounded state: 30 attempts/user/minute, including cache hits. */
export function createExternalLinkService(resolve: ResolveExternalLink = resolveExternalLinkService, now: () => number = Date.now) {
	const users = new Map<number, { count: number; until: number }>();
	const cache = new Map<string, { service: ExternalLinkService | null; until: number }>();
	const pending = new Map<string, Promise<ExternalLinkService | null>>();
	return {
		async resolve(userId: number, url: string) {
			const time = now();
			for (const [key, window] of users) if (window.until <= time) users.delete(key);
			for (const [key, entry] of cache) if (entry.until <= time) cache.delete(key);
			let window = users.get(userId);
			if (!window) {
				if (users.size >= 2000) throw new AppError(429, 'Too many link resolution requests', 'RATE_LIMITED', { retryAfterSec: 60 });
				window = { count: 0, until: time + 60_000 };
				users.set(userId, window);
			}
			if (window.count >= 30) throw new AppError(429, 'Too many link resolution requests', 'RATE_LIMITED', { retryAfterSec: Math.ceil((window.until - time) / 1000) });
			window.count++;
			const key = `${userId}:${url}`;
			const cached = cache.get(key);
			if (cached) return { service: cached.service };
			const existing = pending.get(key);
			if (existing) return { service: await existing };
			if (pending.size >= 100) return { service: null };
			const work = resolve(url).catch(() => null);
			pending.set(key, work);
			try {
				const service = await work;
				if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
				cache.set(key, { service, until: now() + 5 * 60_000 });
				return { service };
			} finally { pending.delete(key); }
		},
	};
}
