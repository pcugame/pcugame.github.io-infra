import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createPublicProductionGraph, type PublicProductionRepository } from '../modules/public/composition.js';

const deploymentId = '123e4567-e89b-42d3-a456-426614174000';

function repository(): PublicProductionRepository {
	const project = {
		id: 7,
		slug: 'immutable-game',
		title: 'Immutable Game',
		summary: '',
		description: '',
		exhibitionId: 1,
		exhibition: { year: 2026 },
		poster: {
			kind: 'POSTER' as const,
			status: 'READY',
			isPublic: true,
			storageKey: 'images/poster generation.webp',
			width: 1200,
			height: 900,
			card480Height: 360,
			display960Height: 720,
		},
		members: [{ id: 1, name: 'Student', studentId: '20260001' }],
		assets: [
			{
				id: 10,
				kind: 'GAME' as const,
				isPublic: false,
				storageKey: 'games/internal.zip',
				mimeType: 'application/zip',
				playbackStorageKey: null,
			},
		],
		isIncomplete: false,
		status: 'PUBLISHED' as const,
		webglEntryKey: `webgl/7/${deploymentId}/site/index.html`,
	};
	return {
		findExhibitionsWithPublishedCounts: vi.fn(async () => [{
			id: 1,
			year: 2026,
			title: 'Show',
			posterStorageKey: 'years/2026 poster.webp',
			posterWidth: 1200,
			posterHeight: 900,
			posterCard480Height: 360,
			posterDisplay960Height: 720,
			_count: { projects: 1 },
		}]),
		findExhibitionsByYear: vi.fn(async () => [{ id: 1, year: 2026, title: 'Show' }]),
		findPublishedProjectsInExhibitions: vi.fn(async () => [project]),
		findExhibitionById: vi.fn(async () => ({ id: 1, year: 2026, title: 'Show' })),
		findPublishedProjectById: vi.fn(async (id: number) => id === 7 ? project : null),
		findPublishedProjectBySlug: vi.fn(async (slug: string) => slug === project.slug ? project : null),
	};
}

async function createApp() {
	const graph = createPublicProductionGraph({
		config: {
			API_PUBLIC_URL: 'https://api.example.test',
			PUBLIC_ASSET_BASE_URL: 'https://assets.example.test/public',
		},
		repository: repository(),
	});
	const app = Fastify();
	await app.register(graph.controller, { prefix: '/api/public' });
	return { app, graph };
}

describe('public production control-plane wiring', () => {
	it('serializes public images and WebGL from the independent immutable origin', async () => {
		const { app } = await createApp();
		const detail = await app.inject({ method: 'GET', url: '/api/public/projects/7' });
		expect(detail.statusCode).toBe(200);
		expect(detail.json().data).toMatchObject({
			poster: {
				original: {
					url: 'https://assets.example.test/public/images/poster%20generation.webp',
				},
			},
			gameDownloadUrl: 'https://api.example.test/api/assets/10/download?variant=original',
			webglUrl: `https://assets.example.test/public/webgl/7/${deploymentId}/site/index.html`,
		});
		expect(JSON.stringify(detail.json().data)).not.toContain('/api/public/images');
		expect(JSON.stringify(detail.json().data)).not.toContain('/api/public/webgl');
		await app.close();
	});

	it('keeps metadata routes but leaves old byte paths unregistered', async () => {
		const { app, graph } = await createApp();
		const [years, image, webgl] = await Promise.all([
			app.inject({ method: 'GET', url: '/api/public/years' }),
			app.inject({ method: 'GET', url: '/api/public/images/object.webp' }),
			app.inject({ method: 'HEAD', url: `/api/public/webgl/7/${deploymentId}/site/index.html` }),
		]);
		expect(years.statusCode).toBe(200);
		expect(years.json().data.items[0].poster.original.url)
			.toBe('https://assets.example.test/public/years/2026%20poster.webp');
		expect(image.statusCode).toBe(404);
		expect(webgl.statusCode).toBe(404);
		expect(graph).not.toHaveProperty('imageService');
		expect(graph).not.toHaveProperty('webglService');
		await app.close();
	});
});
