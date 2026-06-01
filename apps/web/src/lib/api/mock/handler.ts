// ── Mock API 핸들러 ─────────────────────────────────────────
// URL 패턴을 매칭하여 mock 데이터를 반환한다.
// client.ts의 request()에서 VITE_MOCK=true일 때만 호출된다.

import {
	getMockUser,
	getMockRole,
	MOCK_YEARS,
	MOCK_YEAR_PROJECTS,
	MOCK_ADMIN_YEARS,
	findProjectDetail,
	buildAdminProjectItems,
	buildAdminProjectDetail,
} from './data';

type MockRequestOptions = {
	method?: string;
	body?: unknown;
};

function requireAdmin(): void {
	const role = getMockRole();
	if (role !== 'ADMIN' && role !== 'OPERATOR') {
		const err = new Error('Mock: forbidden');
		Object.assign(err, { status: 403 });
		throw err;
	}
}

type MockRoute = {
	pattern: RegExp;
	handler: (match: RegExpMatchArray, method: string, options: MockRequestOptions, path: string) => unknown;
};

const MOCK_SETTINGS = {
	maxGameFileMb: 5120,
	maxChunkSizeMb: 10,
};

const MOCK_BANNED_IPS = [
	{
		id: 1,
		ip: '203.0.113.42',
		reason: 'Mock download rate limit exceeded',
		createdAt: new Date(Date.now() - 86_400_000).toISOString(),
	},
];

type MockGameSession = {
	sessionId: string;
	projectId: number;
	originalName: string;
	totalBytes: number;
	chunkSizeBytes: number;
	totalChunks: number;
	uploadedChunks: number[];
	uploadedCount: number;
	status: string;
	expiresAt: string;
};

const mockGameSessions = new Map<string, MockGameSession>();

function parseJsonBody(body: unknown): Record<string, unknown> {
	if (typeof body !== 'string') return {};
	try {
		const parsed = JSON.parse(body);
		return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

const routes: MockRoute[] = [
	// ── Auth ──
	{
		pattern: /^\/api\/me$/,
		handler: () => ({ authenticated: true, user: getMockUser() }),
	},
	{
		pattern: /^\/api\/auth\/google$/,
		handler: () => ({ user: getMockUser() }),
	},
	{
		pattern: /^\/api\/auth\/logout$/,
		handler: () => ({ message: 'logged out' }),
	},

	// ── Public ──
	{
		pattern: /^\/api\/public\/years$/,
		handler: () => ({ items: MOCK_YEARS }),
	},
	{
		pattern: /^\/api\/public\/years\/(\d+)\/projects$/,
		handler: (match) => {
			const year = Number(match[1]);
			const cards = MOCK_YEAR_PROJECTS[year] ?? [];
			const yearItems = MOCK_YEARS.filter((y) => y.year === year);
			const exhibitions = yearItems.map((y) => ({ id: y.id, title: y.title || `${year} 전시` }));
			const items = cards.map((c) => ({
				...c,
				exhibitionId: yearItems[0]?.id ?? 0,
				exhibitionTitle: yearItems[0]?.title ?? `${year} 전시`,
			}));
			return { year, exhibitions, items, empty: items.length === 0 };
		},
	},
	{
		pattern: /^\/api\/public\/exhibitions\/(\d+)\/projects$/,
		handler: (match) => {
			const exhibitionId = Number(match[1]);
			const exhibition = MOCK_YEARS.find((y) => y.id === exhibitionId);
			if (!exhibition) return notFound();

			const title = exhibition.title || `${exhibition.year} 전시`;
			const cards = MOCK_YEAR_PROJECTS[exhibition.year] ?? [];
			const items = cards.map((c) => ({
				...c,
				exhibitionId: exhibition.id,
				exhibitionTitle: title,
			}));

			return {
				exhibition: {
					id: exhibition.id,
					year: exhibition.year,
					title,
				},
				items,
				empty: items.length === 0,
			};
		},
	},
	{
		pattern: /^\/api\/public\/projects\/([^?]+)/,
		handler: (match) => {
			const idOrSlug = decodeURIComponent(match[1]);
			return findProjectDetail(idOrSlug) ?? notFound();
		},
	},

	// ── Admin Exhibitions (OPERATOR/ADMIN only) ──
	{
		pattern: /^\/api\/admin\/exhibitions$/,
		handler: (_match, method) => {
			requireAdmin();
			if (method === 'POST') return { id: 100, year: 2026 };
			return { items: MOCK_ADMIN_YEARS };
		},
	},
	{
		pattern: /^\/api\/admin\/exhibitions\/([^/]+)$/,
		handler: (match, method) => {
			requireAdmin();
			if (method === 'DELETE') return undefined;
			const id = Number(match[1]);
			return MOCK_ADMIN_YEARS.find((y) => y.id === id) ?? MOCK_ADMIN_YEARS[0];
		},
	},
	{
		pattern: /^\/api\/admin\/exhibitions\/([^/]+)\/poster$/,
		handler: (match, method) => {
			requireAdmin();
			if (method === 'DELETE') return undefined;
			const id = Number(match[1]);
			const item = MOCK_ADMIN_YEARS.find((y) => y.id === id) ?? MOCK_ADMIN_YEARS[0];
			return {
				...item,
				posterUrl: item.posterUrl ?? 'https://placehold.co/540x960/0f172a/f8fafc?text=Poster',
				posterOriginalName: 'poster.webp',
				posterSize: 245760,
			};
		},
	},

	// ── Admin Settings ──
	{
		pattern: /^\/api\/admin\/settings$/,
		handler: () => {
			requireAdmin();
			return MOCK_SETTINGS;
		},
	},

	// ── Admin Banned IPs ──
	{
		pattern: /^\/api\/admin\/banned-ips$/,
		handler: () => {
			requireAdmin();
			return { items: MOCK_BANNED_IPS };
		},
	},
	{
		pattern: /^\/api\/admin\/banned-ips\/([^/]+)$/,
		handler: () => {
			requireAdmin();
			return undefined;
		},
	},

	// ── Admin Import / Export ──
	{
		pattern: /^\/api\/admin\/import\/preview$/,
		handler: () => {
			requireAdmin();
			return {
				valid: true,
				exhibitions: [
					{ year: 2026, title: '졸업작품 전시회', isNew: true, existingProjectCount: 0 },
				],
				projectCount: 3,
				errors: [],
			};
		},
	},
	{
		pattern: /^\/api\/admin\/import\/execute$/,
		handler: () => {
			requireAdmin();
			return {
				exhibitions: { created: 1, existing: 0 },
				projects: { created: 3 },
			};
		},
	},
	{
		pattern: /^\/api\/admin\/export\/status$/,
		handler: () => {
			requireAdmin();
			return { running: false, progress: null };
		},
	},
	{
		pattern: /^\/api\/admin\/export$/,
		handler: () => {
			requireAdmin();
			return {
				projects: 6,
				totalFiles: 18,
				downloaded: 18,
				skipped: 0,
				failed: 0,
				aborted: false,
				paths: ['mock/ExportedAssets/2025/mock-project/poster.webp'],
			};
		},
	},

	// ── Admin Projects ──
	{
		pattern: /^\/api\/admin\/projects\/submit$/,
		handler: () => ({
			id: 999, slug: 'new-project', year: 2025,
			status: 'PUBLISHED', adminEditUrl: '/admin/projects/999/edit',
			publicUrl: '/years/2025/new-project',
		}),
	},
	{
		pattern: /^\/api\/admin\/projects\/bulk\/status$/,
		handler: () => ({ updated: 1 }),
	},
	{
		pattern: /^\/api\/admin\/projects\/bulk\/delete$/,
		handler: () => ({ deleted: 1, assetsRemoved: 3 }),
	},
	{
		pattern: /^\/api\/admin\/projects\/([^/]+)\/game-upload-sessions$/,
		handler: (match, method, options) => {
			const projectId = Number(match[1]);
			if (method === 'POST') {
				const body = parseJsonBody(options.body);
				const totalBytes = Number(body.totalBytes ?? 1024 * 1024);
				const chunkSizeBytes = Math.min(10 * 1024 * 1024, Math.max(1, totalBytes));
				const totalChunks = Math.max(1, Math.ceil(totalBytes / chunkSizeBytes));
				const session: MockGameSession = {
					sessionId: `mock-session-${Date.now()}`,
					projectId,
					originalName: String(body.originalName ?? 'mock-game.zip'),
					totalBytes,
					chunkSizeBytes,
					totalChunks,
					uploadedChunks: [],
					uploadedCount: 0,
					status: 'PENDING',
					expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
				};
				mockGameSessions.set(session.sessionId, session);
				return {
					sessionId: session.sessionId,
					chunkSizeBytes: session.chunkSizeBytes,
					totalChunks: session.totalChunks,
					expiresAt: session.expiresAt,
				};
			}

			return {
				items: [...mockGameSessions.values()].filter((s) =>
					s.projectId === projectId && s.status === 'PENDING'
				),
			};
		},
	},
	{
		pattern: /^\/api\/admin\/game-upload-sessions\/([^/]+)\/chunks\/(\d+)$/,
		handler: (match) => {
			const sessionId = match[1] ?? '';
			const session = mockGameSessions.get(sessionId) ?? notFound();
			const index = Number(match[2]);
			if (!session.uploadedChunks.includes(index)) {
				session.uploadedChunks.push(index);
				session.uploadedChunks.sort((a, b) => a - b);
				session.uploadedCount = session.uploadedChunks.length;
			}
			return {
				index,
				bytesWritten: session.chunkSizeBytes,
				uploadedCount: session.uploadedCount,
				totalChunks: session.totalChunks,
			};
		},
	},
	{
		pattern: /^\/api\/admin\/game-upload-sessions\/([^/]+)\/complete$/,
		handler: (match) => {
			const sessionId = match[1] ?? '';
			const session = mockGameSessions.get(sessionId) ?? notFound();
			session.status = 'COMPLETED';
			return {
				status: 'COMPLETED',
				storageKey: `mock/game/${session.sessionId}.zip`,
				sizeBytes: session.totalBytes,
			};
		},
	},
	{
		pattern: /^\/api\/admin\/game-upload-sessions\/([^/]+)$/,
		handler: (match, method) => {
			const sessionId = match[1] ?? '';
			const session = mockGameSessions.get(sessionId) ?? notFound();
			if (method === 'DELETE') {
				session.status = 'CANCELLED';
				return undefined;
			}
			return session;
		},
	},
	{
		pattern: /^\/api\/admin\/projects\/([^/]+)\/assets$/,
		handler: () => ({ assetId: 900, url: 'https://placehold.co/400x300?text=New+Asset' }),
	},
	{
		pattern: /^\/api\/admin\/projects\/([^/]+)\/poster$/,
		handler: () => ({ posterAssetId: 901 }),
	},
	{
		pattern: /^\/api\/admin\/projects\/([^/]+)\/members\/([^/]+)$/,
		handler: () => undefined,
	},
	{
		pattern: /^\/api\/admin\/projects\/([^/]+)\/members\/swap$/,
		handler: () => undefined,
	},
	{
		pattern: /^\/api\/admin\/projects\/([^/]+)\/members$/,
		handler: () => ({ id: 800 }),
	},
	{
		pattern: /^\/api\/admin\/projects\/([^/]+)$/,
		handler: (match, method) => {
			if (method === 'DELETE') return undefined;
			return buildAdminProjectDetail(match[1]) ?? notFound();
		},
	},
	{
		pattern: /^\/api\/admin\/projects$/,
		handler: (_match, _method, _options, path) => {
			// 실제 API와 동일하게: ADMIN/OPERATOR는 전체, USER는 본인 소유만 반환.
			// /me/projects 페이지가 USER 역할에서도 비어있지 않도록 한다.
			const role = getMockRole();
			const user = getMockUser();
			const isPrivileged = role === 'ADMIN' || role === 'OPERATOR';
			const query = new URLSearchParams(path.split('?')[1] ?? '');
			const page = Math.max(1, Number(query.get('page') ?? 1));
			const limit = Math.min(100, Math.max(1, Number(query.get('limit') ?? 20)));
			const status = query.get('status');
			const year = query.get('year');
			const search = (query.get('search') ?? '').trim().toLowerCase();
			const sort = query.get('sort') ?? 'createdAt';
			const order = query.get('order') === 'asc' ? 'asc' : 'desc';

			let items = buildAdminProjectItems({ userId: user.id, isPrivileged });
			if (status === 'PUBLISHED' || status === 'ARCHIVED') {
				items = items.filter((item) => item.status === status);
			}
			if (year) {
				items = items.filter((item) => item.year === Number(year));
			}
			if (search) {
				items = items.filter((item) =>
					[
						item.title,
						item.year,
						...item.memberNames,
						...item.memberStudentIds,
					].some((value) => String(value).toLowerCase().includes(search))
				);
			}

			items = [...items].sort((a, b) => {
				let cmp = 0;
				if (sort === 'title') cmp = a.title.localeCompare(b.title, 'ko');
				else if (sort === 'year') cmp = a.year - b.year;
				else if (sort === 'status') cmp = a.status.localeCompare(b.status);
				else cmp = a.updatedAt.localeCompare(b.updatedAt);
				return order === 'asc' ? cmp : -cmp;
			});

			const totalItems = items.length;
			const totalPages = Math.ceil(totalItems / limit);
			const start = (page - 1) * limit;
			return {
				items: items.slice(start, start + limit),
				pagination: {
					page,
					limit,
					totalItems,
					totalPages,
					hasNextPage: page < totalPages,
					hasPreviousPage: page > 1 && totalItems > 0,
				},
			};
		},
	},

	// ── Admin Assets ──
	{
		pattern: /^\/api\/admin\/assets\/([^/]+)$/,
		handler: () => undefined,
	},
];

function notFound(): never {
	const err = new Error('Mock: not found');
	Object.assign(err, { status: 404 });
	throw err;
}

/**
 * Mock 요청 핸들러. client.ts의 request()에서 호출된다.
 * 네트워크 지연을 시뮬레이션하기 위해 짧은 딜레이를 둔다.
 */
export async function handleMockRequest<T>(path: string, options: MockRequestOptions = {}): Promise<T> {
	const method = options.method ?? 'GET';
	// query string 제거
	const pathname = path.split('?')[0];

	await new Promise((r) => setTimeout(r, 80 + Math.random() * 120));

	for (const route of routes) {
		const match = pathname.match(route.pattern);
		if (match) {
			if (import.meta.env.DEV) {
				console.log(`[Mock] ${method} ${path}`);
			}
			return route.handler(match, method, options, path) as T;
		}
	}

	console.warn(`[Mock] Unhandled: ${method} ${path}`);
	return undefined as T;
}
