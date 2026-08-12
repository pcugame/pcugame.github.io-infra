import { Readable } from 'node:stream';
import CachePolicy from 'http-cache-semantics';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicController } from '../modules/public/controller.js';
import { createPublicImageService } from '../modules/public/image.service.js';
import {
	createResponsiveImageSerializer,
	deriveImageRenditionStorageKey,
} from '../shared/responsive-image.js';

type CacheEntry = {
	policy: CachePolicy;
	body: Buffer;
};

type SerializedCacheEntry = {
	policy: CachePolicy.CachePolicyObject;
	body: string;
};

type NavigationResult = {
	source: 'network' | 'memory-cache' | 'disk-cache';
	status: number;
	headers: CachePolicy.Headers;
	body: Buffer;
};

/**
 * A cache-aware HTTP user agent backed by the RFC 9111 implementation used by
 * production HTTP clients. It deliberately goes through a real TCP listener;
 * unlike Node fetch by itself, a fresh immutable response is reused without a
 * second origin request. Serializing and reopening the cache models a later
 * navigation using a persisted browser cache.
 */
class CacheAwareNavigationClient {
	readonly origin = { requests: 0, responseBodyBytes: 0 };
	private readonly entries = new Map<string, CacheEntry>();

	constructor(private readonly hitSource: 'memory-cache' | 'disk-cache' = 'memory-cache') {}

	static reopen(snapshot: Map<string, SerializedCacheEntry>): CacheAwareNavigationClient {
		const client = new CacheAwareNavigationClient('disk-cache');
		for (const [url, entry] of snapshot) {
			client.entries.set(url, {
				policy: CachePolicy.fromObject(entry.policy),
				body: Buffer.from(entry.body, 'base64'),
			});
		}
		return client;
	}

	snapshot(): Map<string, SerializedCacheEntry> {
		return new Map([...this.entries].map(([url, entry]) => [url, {
			policy: entry.policy.toObject(),
			body: entry.body.toString('base64'),
		}]));
	}

	async navigate(url: string): Promise<NavigationResult> {
		const request: CachePolicy.HttpRequest = {
			url,
			method: 'GET',
			headers: { accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
		};
		const cached = this.entries.get(url);
		if (cached?.policy.satisfiesWithoutRevalidation(request)) {
			return {
				source: this.hitSource,
				status: 200,
				headers: cached.policy.responseHeaders(),
				body: Buffer.from(cached.body),
			};
		}

		this.origin.requests += 1;
		const response = await fetch(url, { headers: { Accept: String(request.headers.accept) } });
		const body = Buffer.from(await response.arrayBuffer());
		this.origin.responseBodyBytes += body.byteLength;
		const responseHeaders = Object.fromEntries(response.headers.entries());
		const policy = new CachePolicy(request, {
			status: response.status,
			headers: responseHeaders,
		}, { shared: false });
		if (policy.storable()) this.entries.set(url, { policy, body });

		return {
			source: 'network',
			status: response.status,
			headers: responseHeaders,
			body,
		};
	}
}

type Generation = {
	storageKey: string;
	body: Buffer;
	cardBody: Buffer;
	lastModified: Date;
};

function generation(name: string, date: string): Generation {
	return {
		storageKey: `public/${name}.webp`,
		body: Buffer.from(`original:${name}`),
		cardBody: Buffer.from(`card:${name}`),
		lastModified: new Date(date),
	};
}

function httpHarness() {
	const oldGeneration = generation('generation-a', '2026-08-12T01:02:03.000Z');
	const nextGeneration = generation('generation-b', '2026-08-12T02:03:04.000Z');
	const objects = new Map<string, { body: Buffer; lastModified: Date }>();
	for (const item of [oldGeneration, nextGeneration]) {
		objects.set(item.storageKey, { body: item.body, lastModified: item.lastModified });
		objects.set(deriveImageRenditionStorageKey(item.storageKey, 'CARD_480'), {
			body: item.cardBody,
			lastModified: item.lastModified,
		});
	}
	const state = {
		current: oldGeneration,
		isPublic: true,
		cardReady: true,
	};
	const calls = {
		resolve: vi.fn(async (storageKey: string) => {
			if (!state.isPublic) return null;
			const currentCard = deriveImageRenditionStorageKey(state.current.storageKey, 'CARD_480');
			if (
				storageKey === state.current.storageKey
				|| (state.cardReady && storageKey === currentCard)
			) return { storageKey };
			return null;
		}),
		head: vi.fn(async (_bucket: string, storageKey: string) => {
			const object = objects.get(storageKey);
			if (!object) return null;
			return {
				size: object.body.byteLength,
				contentType: 'image/webp',
				etag: `"${storageKey}"`,
				lastModified: object.lastModified,
			};
		}),
		stream: vi.fn(async (_bucket: string, storageKey: string) => {
			const object = objects.get(storageKey);
			if (!object) return null;
			return {
				body: Readable.from([object.body]),
				size: object.body.byteLength,
				contentType: 'image/webp',
				etag: `"${storageKey}"`,
				lastModified: object.lastModified,
			};
		}),
	};
	const imageService = createPublicImageService({
		publicBucket: 'public-images',
		repository: { resolvePublicImage: calls.resolve },
		storage: { head: calls.head, stream: calls.stream },
		logger: { error: vi.fn() },
	});
	const app = Fastify();
	void app.register(createPublicController({
		imageService,
		// Only the image routes are exercised. Registering the production public
		// controller still verifies its real path decoding and response adapter.
		service: {} as never,
		webglService: {} as never,
	}), { prefix: '/api/public' });

	return { app, calls, objects, state, oldGeneration, nextGeneration };
}

function responsiveImage(apiBase: string, item: Generation, cardReady = true) {
	return createResponsiveImageSerializer(apiBase).serializeResponsiveImage({
		storageKey: item.storageKey,
		width: 1_200,
		height: 675,
		card480Height: cardReady ? 270 : null,
		display960Height: null,
	});
}

const apps: FastifyInstance[] = [];

afterEach(async () => {
	await Promise.allSettled(apps.splice(0).map((app) => app.close()));
});

describe('public image cache-aware HTTP navigation', () => {
	it('reuses original and rendition bodies from persisted cache on a later navigation', async () => {
		const harness = httpHarness();
		apps.push(harness.app);
		const apiBase = await harness.app.listen({ host: '127.0.0.1', port: 0 });
		const image = responsiveImage(apiBase, harness.oldGeneration);
		const sameGeneration = responsiveImage(apiBase, harness.oldGeneration);
		expect(sameGeneration).toEqual(image);
		for (const url of [image.original.url, image.renditions[0]?.url]) {
			expect(url).toBeDefined();
			expect(new URL(url!).search).toBe('');
		}

		const firstVisit = new CacheAwareNavigationClient();
		const original = await firstVisit.navigate(image.original.url);
		const rendition = await firstVisit.navigate(image.renditions[0]!.url);
		for (const response of [original, rendition]) {
			expect(response.source).toBe('network');
			expect(response.status).toBe(200);
			expect(response.body.byteLength).toBeGreaterThan(0);
			expect(response.headers['cache-control']).toBe(
				'public, max-age=31536000, immutable',
			);
			expect(response.headers.etag).toBeDefined();
			expect(response.headers['last-modified']).toBe(
				'Wed, 12 Aug 2026 01:02:03 GMT',
			);
		}
		expect(firstVisit.origin).toEqual({
			requests: 2,
			responseBodyBytes: harness.oldGeneration.body.byteLength
				+ harness.oldGeneration.cardBody.byteLength,
		});
		expect(harness.calls.resolve).toHaveBeenCalledTimes(2);
		expect(harness.calls.head).not.toHaveBeenCalled();
		expect(harness.calls.stream).toHaveBeenCalledTimes(2);
		await expect(firstVisit.navigate(image.original.url)).resolves.toMatchObject({
			source: 'memory-cache',
			body: original.body,
		});
		await expect(firstVisit.navigate(image.renditions[0]!.url)).resolves.toMatchObject({
			source: 'memory-cache',
			body: rendition.body,
		});
		expect(firstVisit.origin).toEqual({
			requests: 2,
			responseBodyBytes: harness.oldGeneration.body.byteLength
				+ harness.oldGeneration.cardBody.byteLength,
		});

		const laterVisit = CacheAwareNavigationClient.reopen(firstVisit.snapshot());
		const originalRevisit = await laterVisit.navigate(image.original.url);
		const renditionRevisit = await laterVisit.navigate(image.renditions[0]!.url);
		expect(originalRevisit).toMatchObject({ source: 'disk-cache', body: original.body });
		expect(renditionRevisit).toMatchObject({ source: 'disk-cache', body: rendition.body });
		expect(laterVisit.origin).toEqual({ requests: 0, responseBodyBytes: 0 });
		// A fresh immutable cache hit never reaches authorization or object storage.
		expect(harness.calls.resolve).toHaveBeenCalledTimes(2);
		expect(harness.calls.head).not.toHaveBeenCalled();
		expect(harness.calls.stream).toHaveBeenCalledTimes(2);
	});

	it('uses validators without a body and never opens a stream for HEAD', async () => {
		const harness = httpHarness();
		apps.push(harness.app);
		const apiBase = await harness.app.listen({ host: '127.0.0.1', port: 0 });
		const image = responsiveImage(apiBase, harness.oldGeneration);

		for (const url of [image.original.url, image.renditions[0]!.url]) {
			const before = {
				resolve: harness.calls.resolve.mock.calls.length,
				head: harness.calls.head.mock.calls.length,
				stream: harness.calls.stream.mock.calls.length,
			};
			const first = await fetch(url);
			const firstBody = Buffer.from(await first.arrayBuffer());
			expect(first.status).toBe(200);
			expect(firstBody.byteLength).toBeGreaterThan(0);
			expect(harness.calls.resolve.mock.calls.length - before.resolve).toBe(1);
			expect(harness.calls.head.mock.calls.length - before.head).toBe(0);
			expect(harness.calls.stream.mock.calls.length - before.stream).toBe(1);

			const etag = first.headers.get('etag');
			expect(etag).toBeTruthy();
			const conditional = await fetch(url, { headers: { 'If-None-Match': etag! } });
			expect(conditional.status).toBe(304);
			expect((await conditional.arrayBuffer()).byteLength).toBe(0);
			expect(conditional.headers.get('cache-control')).toBe(
				'public, max-age=31536000, immutable',
			);
			expect(conditional.headers.get('etag')).toBe(etag);
			expect(harness.calls.resolve.mock.calls.length - before.resolve).toBe(2);
			expect(harness.calls.head.mock.calls.length - before.head).toBe(1);
			expect(harness.calls.stream.mock.calls.length - before.stream).toBe(1);

			const head = await fetch(url, { method: 'HEAD' });
			expect(head.status).toBe(200);
			expect((await head.arrayBuffer()).byteLength).toBe(0);
			expect(head.headers.get('last-modified')).toBe(
				'Wed, 12 Aug 2026 01:02:03 GMT',
			);
			expect(harness.calls.resolve.mock.calls.length - before.resolve).toBe(3);
			expect(harness.calls.head.mock.calls.length - before.head).toBe(2);
			expect(harness.calls.stream.mock.calls.length - before.stream).toBe(1);
		}
	});

	it('changes URLs across replacement and rejects stale or private generations before storage', async () => {
		const harness = httpHarness();
		apps.push(harness.app);
		const apiBase = await harness.app.listen({ host: '127.0.0.1', port: 0 });
		const oldImage = responsiveImage(apiBase, harness.oldGeneration);

		harness.state.current = harness.nextGeneration;
		const nextImage = responsiveImage(apiBase, harness.nextGeneration);
		expect(nextImage.original.url).not.toBe(oldImage.original.url);
		expect(nextImage.renditions[0]!.url).not.toBe(oldImage.renditions[0]!.url);
		for (const url of [nextImage.original.url, nextImage.renditions[0]!.url]) {
			expect(new URL(url).search).toBe('');
		}

		const storageCallsBeforeStale = harness.calls.head.mock.calls.length
			+ harness.calls.stream.mock.calls.length;
		for (const url of [oldImage.original.url, oldImage.renditions[0]!.url]) {
			expect((await fetch(url)).status).toBe(404);
		}
		expect(harness.calls.head.mock.calls.length + harness.calls.stream.mock.calls.length)
			.toBe(storageCallsBeforeStale);

		const nextVisit = new CacheAwareNavigationClient();
		await expect(nextVisit.navigate(nextImage.original.url)).resolves.toMatchObject({
			source: 'network',
			status: 200,
		});
		await expect(nextVisit.navigate(nextImage.renditions[0]!.url)).resolves.toMatchObject({
			source: 'network',
			status: 200,
		});
		const storageCallsAfterNext = harness.calls.head.mock.calls.length
			+ harness.calls.stream.mock.calls.length;
		const nextRevisit = CacheAwareNavigationClient.reopen(nextVisit.snapshot());
		await expect(nextRevisit.navigate(nextImage.original.url)).resolves.toMatchObject({
			source: 'disk-cache',
		});
		await expect(nextRevisit.navigate(nextImage.renditions[0]!.url)).resolves.toMatchObject({
			source: 'disk-cache',
		});
		expect(nextRevisit.origin).toEqual({ requests: 0, responseBodyBytes: 0 });
		expect(harness.calls.head.mock.calls.length + harness.calls.stream.mock.calls.length)
			.toBe(storageCallsAfterNext);

		harness.state.isPublic = false;
		const storageCallsBeforePrivate = harness.calls.head.mock.calls.length
			+ harness.calls.stream.mock.calls.length;
		// Node's native fetch has no HTTP response cache; these are fresh origin
		// requests rather than reads from the navigation cache above.
		expect((await fetch(nextImage.original.url)).status).toBe(404);
		expect((await fetch(nextImage.renditions[0]!.url)).status).toBe(404);
		expect(harness.calls.head.mock.calls.length + harness.calls.stream.mock.calls.length)
			.toBe(storageCallsBeforePrivate);
	});

	it('keeps a legacy original without readiness metadata on the same cacheable route', async () => {
		const harness = httpHarness();
		apps.push(harness.app);
		const apiBase = await harness.app.listen({ host: '127.0.0.1', port: 0 });
		const legacy = generation('legacy-no-metadata', '2026-08-12T03:04:05.000Z');
		harness.objects.set(legacy.storageKey, {
			body: legacy.body,
			lastModified: legacy.lastModified,
		});
		harness.state.current = legacy;
		harness.state.cardReady = false;
		const image = createResponsiveImageSerializer(apiBase).serializeResponsiveImage({
			storageKey: legacy.storageKey,
		});
		expect(image.renditions).toEqual([]);

		const firstVisit = new CacheAwareNavigationClient();
		await expect(firstVisit.navigate(image.original.url)).resolves.toMatchObject({
			source: 'network',
			status: 200,
			body: legacy.body,
		});
		const revisit = CacheAwareNavigationClient.reopen(firstVisit.snapshot());
		await expect(revisit.navigate(image.original.url)).resolves.toMatchObject({
			source: 'disk-cache',
			body: legacy.body,
		});
		expect(revisit.origin).toEqual({ requests: 0, responseBodyBytes: 0 });
	});
});
