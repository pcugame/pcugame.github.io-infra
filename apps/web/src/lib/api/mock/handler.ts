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
	handler: (match: RegExpMatchArray, method: string) => unknown;
};

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

	// ── Admin Projects ──
	{
		pattern: /^\/api\/admin\/projects\/submit$/,
		handler: () => ({
			id: 999, slug: 'new-project', year: 2025,
			status: 'DRAFT', adminEditUrl: '/admin/projects/999/edit',
		}),
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
		handler: () => {
			requireAdmin();
			return { items: buildAdminProjectItems() };
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
export async function handleMockRequest<T>(path: string, options: { method?: string } = {}): Promise<T> {
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
			return route.handler(match, method) as T;
		}
	}

	console.warn(`[Mock] Unhandled: ${method} ${path}`);
	return undefined as T;
}
