import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { detectExternalLinkService, type ExternalLink, type ExternalLinkService } from '@pcu/contracts';

export interface ResolvedAddress { address: string; family: number }
export interface RedirectHeaders { status: number; location?: string }
export interface ResolverDependencies {
	lookup(hostname: string): Promise<ResolvedAddress[]>;
	requestHeaders(url: URL, address: ResolvedAddress, signal: AbortSignal): Promise<RedirectHeaders>;
}

/** Fail closed for special-use addresses, including mapped/transition IPv6. */
export function isPublicAddress(value: string): boolean {
	if (!isIP(value) || value.includes('%')) return false;
	const address = ipaddr.parse(value);
	if (address.range() !== 'unicast') return false;
	// IPv6 allocations outside global unicast can be reserved without a named range.
	return address.kind() === 'ipv4' || address.match(ipaddr.parse('2000::'), 3);
}

function safeUrl(value: string): URL | null {
	try {
		const url = new URL(value);
		if (value.length > 2000 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
		return url;
	} catch { return null; }
}

/** Cancel the wait even when the OS DNS query cannot itself be cancelled. */
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(new Error('External link resolution aborted'));
		if (signal.aborted) abort();
		else signal.addEventListener('abort', abort, { once: true });
		pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => undefined);
	});
}

/** The validated address is the only result the socket's lookup can receive. */
export const requestPinnedHeaders: ResolverDependencies['requestHeaders'] = (url, address, signal) => new Promise((resolve, reject) => {
	const transport = url.protocol === 'https:' ? https : http;
	const request = transport.request(url, {
		method: 'GET',
		agent: false,
		signal,
		maxHeaderSize: 16 * 1024,
		headers: { Accept: '*/*', 'User-Agent': 'PCU-External-Link-Resolver/1.0' },
		// Keep the original hostname for Host and TLS certificate/SNI validation,
		// but never perform another DNS lookup while opening the connection.
		lookup: (_hostname, options, callback) => {
			if (options.all) callback(null, [address]);
			else callback(null, address.address, address.family);
		},
	}, (response) => {
		resolve({ status: response.statusCode ?? 0, location: response.headers.location });
		// No response body, cookies, or credentials are read or forwarded.
		response.destroy();
		request.destroy();
	});
	request.once('error', reject);
	request.end();
});

const productionDependencies: ResolverDependencies = {
	lookup: (hostname) => lookup(hostname, { all: true, verbatim: true }),
	requestHeaders: requestPinnedHeaders,
};

export function createExternalLinkResolver(deps: ResolverDependencies = productionDependencies) {
	return async function resolve(value: string, parentSignal?: AbortSignal): Promise<ExternalLinkService | null> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 3000);
		const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
		try {
			let current = safeUrl(value);
			const visited = new Set<string>();
			for (let redirects = 0; current && redirects <= 5; redirects++) {
				if (signal.aborted || visited.has(current.href)) return null;
				visited.add(current.href);
				const known = detectExternalLinkService(current.href);
				if (known) return known;
				const hostname = current.hostname.replace(/^\[|\]$/g, '');
				const family = isIP(hostname);
				const addresses = family ? [{ address: hostname, family }] : await abortable(deps.lookup(hostname), signal);
				// Reject mixed public/private answers rather than allowing fallback to a
				// forbidden address. Each hop independently repeats this validation.
				if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address) || isIP(item.address) !== item.family)) return null;
				if (signal.aborted) return null;
				const response = await abortable(deps.requestHeaders(current, addresses[0]!, signal), signal);
				if (![301, 302, 303, 307, 308].includes(response.status) || !response.location || redirects === 5) return null;
				current = safeUrl(new URL(response.location, current).href);
			}
		} catch { /* Resolution is optional metadata; failures leave a generic link. */ }
		finally { clearTimeout(timeout); }
		return null;
	};
}

export type ResolveExternalLink = ReturnType<typeof createExternalLinkResolver>;
export const resolveExternalLinkService = createExternalLinkResolver();

/** Preserve user text and order, ignore all submitted service hints, cap the whole batch. */
export async function enrichExternalLinks(links: ExternalLink[], resolve: ResolveExternalLink = resolveExternalLinkService): Promise<ExternalLink[]> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5000);
	const result: ExternalLink[] = links.map(({ label, url }) => {
		const service = detectExternalLinkService(url);
		return { label, url, ...(service ? { service } : {}) };
	});
	let next = 0;
	try {
		await Promise.all(Array.from({ length: Math.min(3, links.length) }, async () => {
			while (next < links.length && !controller.signal.aborted) {
				const index = next++;
				if (result[index]!.service) continue;
				const service = await abortable(resolve(links[index]!.url, controller.signal), controller.signal).catch(() => null);
				if (service) result[index]!.service = service;
			}
		}));
	} finally { clearTimeout(timeout); }
	return result;
}
