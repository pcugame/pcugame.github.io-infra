import http from 'node:http';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExternalLinkResolver, enrichExternalLinks, isPublicAddress, requestPinnedHeaders } from '../modules/external-links/resolver.js';
import type { ResolverDependencies } from '../modules/external-links/resolver.js';
import { createExternalLinkService } from '../modules/external-links/service.js';

function dependencies() {
	return {
		lookup: vi.fn<ResolverDependencies['lookup']>().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
		requestHeaders: vi.fn<ResolverDependencies['requestHeaders']>().mockResolvedValue({ status: 302, location: 'https://github.com/pcu/game' }),
	};
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('external link SSRF boundary', () => {
	it.each([
		'0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254',
		'172.16.0.1', '192.0.0.9', '192.0.2.1', '192.168.1.1', '192.88.99.1',
		'192.175.48.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1',
		'::', '::1', 'fc00::1', 'fe80::1', 'fec0::1', 'ff02::1', '2001:db8::1', '2001:2::1',
		'2001::1', '2002:7f00:1::1', '3fff::1', '4000::1', '64:ff9b::a00:1',
		'::ffff:127.0.0.1', '::ffff:8.8.8.8', '::127.0.0.1', 'fe80::1%eth0', 'not-an-ip',
	])('rejects nonpublic or mapped address %s', (address) => { expect(isPublicAddress(address)).toBe(false); });
	it.each(['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888'])('accepts public address %s', (address) => { expect(isPublicAddress(address)).toBe(true); });

	it.each(['ftp://example.com', 'http://user:pass@example.com', 'http://example.com:8080', 'https://example.com:80', 'bad url'])('does not request invalid target %s', async (url) => {
		const deps = dependencies();
		expect(await createExternalLinkResolver(deps)(url)).toBeNull();
		expect(deps.lookup).not.toHaveBeenCalled(); expect(deps.requestHeaders).not.toHaveBeenCalled();
	});
	it.each(['http://127.0.0.1', 'http://2130706433', 'http://0x7f000001', 'http://[::1]', 'http://[::ffff:127.0.0.1]'])('does not connect to local literal %s', async (url) => {
		const deps = dependencies();
		expect(await createExternalLinkResolver(deps)(url)).toBeNull();
		expect(deps.requestHeaders).not.toHaveBeenCalled();
	});
	it('recognizes direct domains without network and rejects service credentials/ports', async () => {
		const deps = dependencies(); const resolve = createExternalLinkResolver(deps);
		expect(await resolve('https://youtu.be/game')).toBe('youtube');
		expect(await resolve('https://github.com:443/game')).toBe('github');
		expect(await resolve('https://user@github.com/game')).toBeNull();
		expect(await resolve('https://github.com:8443/game')).toBeNull();
		expect(deps.lookup).not.toHaveBeenCalled(); expect(deps.requestHeaders).not.toHaveBeenCalled();
	});
	it('rejects any forbidden DNS answer, including a public/private mix', async () => {
		const deps = dependencies();
		deps.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '::ffff:10.0.0.1', family: 6 }]);
		expect(await createExternalLinkResolver(deps)('https://short.example/game')).toBeNull();
		expect(deps.requestHeaders).not.toHaveBeenCalled();
	});
	it('follows relative redirects and validates fresh DNS on every hop', async () => {
		const deps = dependencies();
		deps.lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]).mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]);
		deps.requestHeaders.mockResolvedValueOnce({ status: 301, location: '/second' });
		expect(await createExternalLinkResolver(deps)('https://short.example/first')).toBe('github');
		expect(deps.lookup).toHaveBeenCalledTimes(2);
		expect(deps.requestHeaders.mock.calls[0]?.[1]).toEqual({ address: '93.184.216.34', family: 4 });
		expect(deps.requestHeaders.mock.calls[1]?.[0].href).toBe('https://short.example/second');
		expect(deps.requestHeaders.mock.calls[1]?.[1]).toEqual({ address: '8.8.8.8', family: 4 });
	});
	it('blocks DNS rebinding at a subsequent same-host hop', async () => {
		const deps = dependencies();
		deps.lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
		deps.requestHeaders.mockResolvedValue({ status: 302, location: '/next' });
		expect(await createExternalLinkResolver(deps)('http://rebind.example/start')).toBeNull();
		expect(deps.requestHeaders).toHaveBeenCalledTimes(1);
	});
	it.each(['http://169.254.169.254/latest/meta-data', 'http://[::ffff:127.0.0.1]', 'https://secret@github.com/game', 'https://github.com:8443/game', 'file:///etc/passwd'])('blocks forbidden redirect %s', async (location) => {
		const deps = dependencies(); deps.requestHeaders.mockResolvedValue({ status: 302, location });
		expect(await createExternalLinkResolver(deps)('https://short.example/')).toBeNull();
		expect(deps.requestHeaders).toHaveBeenCalledTimes(1);
	});
	it('permits exactly five redirects to a known service', async () => {
		const deps = dependencies();
		for (let index = 0; index < 4; index++) deps.requestHeaders.mockResolvedValueOnce({ status: 302, location: `/hop${index}` });
		expect(await createExternalLinkResolver(deps)('https://short.example/start')).toBe('github');
		expect(deps.requestHeaders).toHaveBeenCalledTimes(5);
	});
	it('stops excess redirects and cycles', async () => {
		const deps = dependencies();
		deps.requestHeaders.mockImplementation(async (url) => ({ status: 302, location: `${url.href}x` }));
		expect(await createExternalLinkResolver(deps)('https://short.example/start')).toBeNull();
		expect(deps.requestHeaders).toHaveBeenCalledTimes(6);
		deps.requestHeaders.mockClear().mockResolvedValue({ status: 302, location: '/start' });
		expect(await createExternalLinkResolver(deps)('https://short.example/start')).toBeNull();
		expect(deps.requestHeaders).toHaveBeenCalledTimes(1);
	});
	it('includes a stalled DNS query in the three-second deadline', async () => {
		vi.useFakeTimers(); const deps = dependencies();
		let release!: (addresses: Array<{ address: string; family: number }>) => void;
		deps.lookup.mockReturnValue(new Promise((resolve) => { release = resolve; }));
		const result = createExternalLinkResolver(deps)('https://slow.example/');
		await vi.advanceTimersByTimeAsync(3000); expect(await result).toBeNull();
		release([{ address: '93.184.216.34', family: 4 }]); await Promise.resolve();
		expect(deps.requestHeaders).not.toHaveBeenCalled();
	});
	it('includes all HTTP hops in one deadline and aborts the active request', async () => {
		vi.useFakeTimers(); const deps = dependencies(); let signal: AbortSignal | undefined;
		deps.requestHeaders.mockImplementation((_url, _address, currentSignal) => { signal = currentSignal; return new Promise(() => {}); });
		const result = createExternalLinkResolver(deps)('https://slow.example/');
		await vi.advanceTimersByTimeAsync(3000); expect(await result).toBeNull(); expect(signal?.aborted).toBe(true);
	});
	it('pins socket DNS and drops the response without collecting body or forwarding credentials', async () => {
		const response = { statusCode: 302, headers: { location: 'https://github.com/game', 'set-cookie': ['secret=yes'] }, destroy: vi.fn() };
		const request = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
		let options!: http.RequestOptions;
		vi.spyOn(http, 'request').mockImplementation(((url: URL, supplied: http.RequestOptions, callback: (response: unknown) => void) => {
			expect(url.hostname).toBe('short.example'); options = supplied;
			request.end.mockImplementation(() => callback(response)); return request;
		}) as unknown as typeof http.request);
		await expect(requestPinnedHeaders(new URL('http://short.example/path'), { address: '8.8.8.8', family: 4 }, new AbortController().signal)).resolves.toEqual({ status: 302, location: 'https://github.com/game' });
		const callback = vi.fn();
		options.lookup!('short.example', { all: false }, callback);
		expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
		const allCallback = vi.fn(); options.lookup!('short.example', { all: true }, allCallback);
		expect(allCallback).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);
		expect(options.agent).toBe(false); expect(options.headers).toEqual({ Accept: '*/*', 'User-Agent': 'PCU-External-Link-Resolver/1.0' });
		expect(response.destroy).toHaveBeenCalledOnce(); expect(request.destroy).toHaveBeenCalledOnce();
	});
});

describe('metadata resolution budgets', () => {
	it('keeps original URL/label and order while replacing forged service hints', async () => {
		const resolve = vi.fn().mockResolvedValueOnce('youtube').mockResolvedValueOnce(null);
		expect(await enrichExternalLinks([{ label: 'Video', url: 'https://short.example/video', service: 'github' }, { label: 'Site', url: 'https://generic.example/', service: 'discord' }], resolve)).toEqual([{ label: 'Video', url: 'https://short.example/video', service: 'youtube' }, { label: 'Site', url: 'https://generic.example/' }]);
	});
	it('caps the whole batch at five seconds, keeps direct known services, and cancels active work', async () => {
		vi.useFakeTimers(); const signals: AbortSignal[] = [];
		const resolve = vi.fn((_url: string, signal?: AbortSignal) => { signals.push(signal!); return new Promise<null>(() => {}); });
		const result = enrichExternalLinks([...Array.from({ length: 19 }, (_, index) => ({ label: String(index), url: `https://slow.example/${index}`, service: 'github' as const })), { label: 'Last', url: 'https://github.com/pcu/game', service: 'discord' }], resolve);
		await vi.advanceTimersByTimeAsync(5000); const links = await result;
		expect(resolve).toHaveBeenCalledTimes(3); expect(signals.every((signal) => signal.aborted)).toBe(true);
		expect(links.slice(0, 19).every((link) => link.service === undefined)).toBe(true);
		expect(links[19]).toEqual({ label: 'Last', url: 'https://github.com/pcu/game', service: 'github' });
	});
	it('limits attempts by user across URLs and cache hits, expires windows and caches', async () => {
		let now = 0; const resolve = vi.fn().mockResolvedValue('github'); const service = createExternalLinkService(resolve, () => now);
		for (let index = 0; index < 30; index++) expect(await service.resolve(1, 'https://short.example/')).toEqual({ service: 'github' });
		expect(resolve).toHaveBeenCalledOnce();
		await expect(service.resolve(1, 'https://other.example/')).rejects.toMatchObject({ statusCode: 429 });
		await expect(service.resolve(2, 'https://short.example/')).resolves.toEqual({ service: 'github' });
		now = 60_000; await service.resolve(1, 'https://short.example/'); expect(resolve).toHaveBeenCalledTimes(2);
		now = 360_000; await service.resolve(1, 'https://short.example/'); expect(resolve).toHaveBeenCalledTimes(3);
	});
	it('bounds cache entries and active limiter users without evicting live limits', async () => {
		const resolve = vi.fn().mockResolvedValue(null); const service = createExternalLinkService(resolve);
		for (let user = 1; user <= 1001; user++) await service.resolve(user, 'https://cache.example/');
		await service.resolve(1, 'https://cache.example/'); expect(resolve).toHaveBeenCalledTimes(1002);
		for (let user = 1002; user <= 2000; user++) await service.resolve(user, 'https://cache.example/');
		await expect(service.resolve(2001, 'https://cache.example/')).rejects.toMatchObject({ statusCode: 429 });
	});
	it('deduplicates in-flight requests and bounds concurrent outbound work', async () => {
		const releases: Array<(service: null) => void> = [];
		const resolve = vi.fn().mockImplementation(() => new Promise<null>((done) => { releases.push(done); }));
		const service = createExternalLinkService(resolve);
		const first = service.resolve(1, 'https://short.example/'); const second = service.resolve(1, 'https://short.example/');
		expect(resolve).toHaveBeenCalledOnce(); releases[0]!(null); await Promise.all([first, second]);
		const pending = Array.from({ length: 100 }, (_, user) => service.resolve(user + 10, 'https://busy.example/'));
		await expect(service.resolve(999, 'https://overflow.example/')).resolves.toEqual({ service: null });
		expect(resolve).toHaveBeenCalledTimes(101);
		// The production resolver completes in three seconds; release all mocked work.
		for (const done of releases) done(null);
		await Promise.all(pending);
	});
});
