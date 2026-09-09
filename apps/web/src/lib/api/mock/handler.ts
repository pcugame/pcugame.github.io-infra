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
	mockResponsiveImage,
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

type MockDirectAssetSession = {
	sessionId: string;
	owner: { type: 'PROJECT' | 'EXHIBITION'; id: number };
	kind: 'GAME' | 'WEBGL' | 'VIDEO' | 'IMAGE' | 'POSTER' | 'DOCUMENT' | 'ATTACHMENT';
	generation: number;
	partSizeBytes: number;
	totalParts: number;
	expiresAt: string;
	originalName: string;
	totalBytes: number;
	sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1';
	sourceIdentity: string;
	state: 'UPLOADING' | 'VERIFYING' | 'READY' | 'CANCELLED';
	parts: Map<number, { etag: string; sizeBytes: number }>;
	submissionItemId?: string;
};
const mockDirectAssetSessions = new Map<string, MockDirectAssetSession>();
type MockSubmissionItem = {
	id: string;
	kind: MockDirectAssetSession['kind'];
	slot: string;
	clientToken: string;
	required: boolean;
	state: 'EXPECTED' | 'UPLOADING' | 'VERIFYING' | 'READY' | 'FAILED' | 'CANCELLED';
	sessionId?: string;
	generation?: number;
};
let mockProjectSubmission: {
	submissionId: string;
	projectId: number;
	projectStatus: 'DRAFT' | 'PUBLISHED';
	state: 'PENDING' | 'PUBLISHED' | 'CANCELLED';
	items: MockSubmissionItem[];
} | null = null;
let mockExportJobId = 0;
let mockDirectAssetSessionId = 0;

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
				poster: item.poster ?? mockResponsiveImage(
					'https://placehold.co/540x960/0f172a/f8fafc?text=Poster',
				),
				posterOriginalName: 'poster.webp',
				posterSize: 245760,
			};
		},
	},

	// ── Direct multipart controls ─────────────────────────────
	// These routes mirror the canonical Garage capability protocol.  Mock
	// UploadPart uses a separate mock://-style path rather than an API body.
	{
		pattern: /^\/api\/admin\/(projects|exhibitions)\/(\d+)\/direct-(game|webgl|video|image|poster|document|attachment)-upload-sessions$/,
		handler: (match, method, options) => {
			if (method !== 'POST') return notFound();
			const ownerType = match[1] === 'projects' ? 'PROJECT' : 'EXHIBITION';
			const kind = String(match[3]).toUpperCase() as MockDirectAssetSession['kind'];
			if (ownerType === 'EXHIBITION') requireAdmin();
			if (ownerType === 'EXHIBITION' && kind !== 'POSTER') return notFound();
			const body = parseJsonBody(options.body);
			const totalBytes = Math.max(1, Number(body.totalBytes ?? 1));
			const partSizeBytes = 5 * 1024 * 1024;
			const session: MockDirectAssetSession = {
				sessionId: `mock-direct-${++mockDirectAssetSessionId}`,
				owner: { type: ownerType, id: Number(match[2]) },
				kind,
				generation: 1,
				partSizeBytes,
				totalParts: Math.max(1, Math.ceil(totalBytes / partSizeBytes)),
				expiresAt: new Date(Date.now() + 300_000).toISOString(),
				originalName: String(body.originalName ?? 'mock-upload.bin'),
				totalBytes,
				sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1',
				sourceIdentity: String(body.sourceIdentity ?? '0'.repeat(64)),
				state: 'UPLOADING',
				parts: new Map(),
				...(body.submissionItem && typeof body.submissionItem === 'object'
					? { submissionItemId: String((body.submissionItem as { id?: unknown }).id ?? '') }
					: {}),
			};
			const submissionItem = mockProjectSubmission?.items.find((item) => item.id === session.submissionItemId);
			if (submissionItem) {
				submissionItem.state = 'UPLOADING';
				submissionItem.sessionId = session.sessionId;
				submissionItem.generation = session.generation;
			}
			mockDirectAssetSessions.set(session.sessionId, session);
			return {
				sessionId: session.sessionId,
				owner: session.owner,
				generation: session.generation,
				partSizeBytes: session.partSizeBytes,
				totalParts: session.totalParts,
				expiresAt: session.expiresAt,
				sourceIdentityAlgorithm: session.sourceIdentityAlgorithm,
				sourceIdentity: session.sourceIdentity,
			};
		},
	},
	{
		pattern: /^\/api\/admin\/direct-asset-upload-sessions\/([^/]+)\/part-urls$/,
		handler: (match, method, options) => {
			if (method !== 'POST') return notFound();
			const session = mockDirectAssetSessions.get(match[1] ?? '') ?? notFound();
			if (session.state !== 'UPLOADING') return notFound();
			const body = parseJsonBody(options.body);
			const requested = Array.isArray(body.parts) ? body.parts : [];
			return {
				generation: session.generation,
				expiresAt: new Date(Date.now() + 300_000).toISOString(),
				parts: requested.map((part) => {
					const partNumber = Number((part as { partNumber?: unknown }).partNumber);
					return {
						partNumber,
						url: `/mock/garage-upload/${session.sessionId}/${partNumber}`,
						requiredHeaders: {},
					};
				}),
			};
		},
	},
	{
		pattern: /^\/mock\/garage-upload\/([^/]+)\/(\d+)$/,
		handler: (match, method, options) => {
			if (method !== 'PUT') return notFound();
			const session = mockDirectAssetSessions.get(match[1] ?? '') ?? notFound();
			if (session.state !== 'UPLOADING') return notFound();
			const partNumber = Number(match[2]);
			const sizeBytes = options.body instanceof Blob ? options.body.size : 0;
			const etag = `mock-etag-${session.sessionId}-${partNumber}`;
			session.parts.set(partNumber, { etag, sizeBytes });
			return { etag };
		},
	},
	{
		pattern: /^\/api\/admin\/direct-asset-upload-sessions\/([^/]+)\/complete$/,
		handler: (match, method) => {
			if (method !== 'POST') return notFound();
			const session = mockDirectAssetSessions.get(match[1] ?? '') ?? notFound();
			if (session.state !== 'UPLOADING') return notFound();
			// The actual worker owns verification.  The mock makes the next status
			// poll READY while preserving the VERIFYING completion response shape.
			session.state = 'READY';
			const submissionItem = mockProjectSubmission?.items.find((item) => item.id === session.submissionItemId);
			if (submissionItem) submissionItem.state = 'READY';
			return { status: 'VERIFYING', sessionId: session.sessionId, generation: session.generation, sizeBytes: session.totalBytes };
		},
	},
	{
		pattern: /^\/api\/admin\/direct-asset-upload-sessions\/([^/]+)$/,
		handler: (match, method) => {
			const session = mockDirectAssetSessions.get(match[1] ?? '') ?? notFound();
			if (method === 'DELETE') {
				session.state = 'CANCELLED';
				return undefined;
			}
			return {
				sessionId: session.sessionId,
				owner: session.owner,
				kind: session.kind,
				state: session.state,
				generation: session.generation,
				originalName: session.originalName,
				totalBytes: session.totalBytes,
				partSizeBytes: session.partSizeBytes,
				totalParts: session.totalParts,
				expiresAt: session.expiresAt,
				sourceIdentityAlgorithm: session.sourceIdentityAlgorithm,
				sourceIdentity: session.sourceIdentity,
				parts: [...session.parts].map(([partNumber, part]) => ({ partNumber, ...part })),
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
			return {
				running: false,
				progress: null,
				jobId: `mock-export-${mockExportJobId || 1}`,
				state: 'READY',
				result: {
					projects: 6, totalFiles: 18, downloaded: 18, skipped: 0, failed: 0,
					aborted: false, paths: ['mock/ExportedAssets/2025/mock-project/poster.webp'],
				},
				error: null,
			};
		},
	},
	{
		pattern: /^\/api\/admin\/export$/,
		handler: () => {
			requireAdmin();
			mockExportJobId++;
			return { jobId: `mock-export-${mockExportJobId}`, state: 'QUEUED' };
		},
	},

	// ── Admin Projects ──
	{
		pattern: /^\/api\/(admin|me)\/projects\/submit$/,
		handler: (match, method, options) => {
			if (match[1] === 'admin') requireAdmin();
			if (method !== 'POST') return notFound();
			const raw = options.body instanceof FormData ? options.body.get('payload') : null;
			const payload = typeof raw === 'string' ? parseJsonBody(raw) : {};
			const manifest = Array.isArray(payload.manifest) ? payload.manifest : [];
			mockProjectSubmission = {
				submissionId: crypto.randomUUID(),
				projectId: 999,
				projectStatus: 'DRAFT',
				state: 'PENDING',
				items: manifest.map((entry) => {
					const item = entry as Record<string, unknown>;
					return {
						id: crypto.randomUUID(),
						kind: String(item.kind) as MockDirectAssetSession['kind'],
						slot: String(item.slot),
						clientToken: String(item.clientToken),
						required: item.required !== false,
						state: 'EXPECTED' as const,
					};
				}),
			};
			return {
				id: 999, slug: 'new-project', year: 2025,
				status: 'DRAFT', submissionId: mockProjectSubmission.submissionId,
				items: mockProjectSubmission.items,
				adminEditUrl: '/admin/projects/999/edit',
			};
		},
	},
	{
		pattern: /^\/api\/(admin|me)\/projects\/(\d+)\/submission(?:\/(finalize))?$/,
		handler: (match, method) => {
			if (match[1] === 'admin') requireAdmin();
			const submission = mockProjectSubmission;
			if (!submission || submission.projectId !== Number(match[2])) return notFound();
			if (method === 'DELETE') {
				submission.state = 'CANCELLED';
				submission.items.forEach((item) => { if (item.state !== 'READY') item.state = 'CANCELLED'; });
				return submission;
			}
			if (match[3] === 'finalize' && method === 'POST') {
				if (!submission.items.every((item) => item.state === 'READY')) throw new Error('Mock: submission not ready');
				submission.state = 'PUBLISHED';
				submission.projectStatus = 'PUBLISHED';
			}
			return submission;
		},
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
