// ── Mock 데이터 ─────────────────────────────────────────────
// VITE_MOCK=true 일 때 실제 API 대신 사용되는 가짜 데이터.
// legacy-import.json의 실제 구조를 참고하여 작성.

import type {
	PublicYearItem,
	PublicProjectCard,
	PublicProjectDetailResponse,
	AuthUser,
	AdminYearItem,
	AdminProjectItem,
	AdminProjectDetail,
} from '../../../contracts';

// ── 사용자 ──────────────────────────────────────────────────

export const MOCK_USER: AuthUser = {
	id: 'mock-user-1',
	email: 'test-admin@test.pcu.ac.kr',
	name: '테스트',
	role: 'ADMIN',
};

// ── 연도 ────────────────────────────────────────────────────
// 실제 데이터: "{year} 졸업작품전" 형식

export const MOCK_YEARS: PublicYearItem[] = [
	{ id: 'y1', year: 2025, title: '2025 졸업작품전', projectCount: 6 },
	{ id: 'y2', year: 2024, title: '2024 졸업작품전', projectCount: 5 },
	{ id: 'y3', year: 2023, title: '2023 졸업작품전', projectCount: 4 },
	{ id: 'y4', year: 2022, title: '2022 졸업작품전', projectCount: 3 },
];

// ── 프로젝트 카드 ────────────────────────────────────────────
// 실제 패턴: 영문 제목 다수, 한글 제목 일부, 1~3인 팀, 학번은 20XX0XX 형식

const MOCK_PROJECTS_2025: PublicProjectCard[] = [
	{
		id: 'p1', slug: 'dragon-slayer', title: 'Dragon Slayer',
		summary: '판타지 세계관 기반 3D 액션 RPG',
		posterUrl: 'https://placehold.co/400x560/1a1a2e/e0e0ff?text=Dragon+Slayer',
		members: [
			{ name: '테스트A', studentId: '2088001' },
			{ name: '테스트B', studentId: '2088002' },
			{ name: '테스트C', studentId: '2088003' },
		],
	},
	{
		id: 'p2', slug: '냥이의-식탁', title: '냥이의 식탁',
		summary: '고양이 캐릭터 기반 요리 시뮬레이션 게임',
		posterUrl: 'https://placehold.co/400x560/2e1a2e/ffe0ff?text=%EB%83%A5%EC%9D%B4%EC%9D%98+%EC%8B%9D%ED%83%81',
		members: [
			{ name: '테스트D', studentId: '2088004' },
			{ name: '테스트E', studentId: '2088005' },
		],
	},
	{
		id: 'p3', slug: 'dungeon-crawl', title: 'Dungeon Crawl',
		summary: '절차적 생성 던전 탐험 로그라이크',
		posterUrl: 'https://placehold.co/400x560/1a2e2e/e0ffff?text=Dungeon+Crawl',
		members: [
			{ name: '테스트F', studentId: '2088006' },
		],
	},
	{
		id: 'p4', slug: 'bpm-beats-per-minute', title: 'BPM: BEATS PER MINUTE',
		summary: '리듬에 맞춰 전투하는 FPS 리듬 게임',
		posterUrl: 'https://placehold.co/400x560/2e1a1a/ffe0e0?text=BPM',
		members: [
			{ name: '테스트G', studentId: '2088007' },
		],
	},
	{
		id: 'p5', slug: 'undead-rush', title: 'UNDEAD RUSH',
		summary: '좀비 서바이벌 탑다운 슈터',
		posterUrl: 'https://placehold.co/400x560/1a2e1a/e0ffe0?text=UNDEAD+RUSH',
		members: [
			{ name: '테스트H', studentId: '2088008' },
		],
	},
	{
		id: 'p6', slug: 'airstrike', title: 'AirStrike',
		summary: '비행 슈팅 아케이드 게임',
		posterUrl: 'https://placehold.co/400x560/2e2e1a/ffffe0?text=AirStrike',
		members: [
			{ name: '테스트I', studentId: '2088009' },
			{ name: '테스트J', studentId: '2088010' },
		],
	},
];

const MOCK_PROJECTS_2024: PublicProjectCard[] = [
	{
		id: 'p7', slug: 'music-library', title: 'MUSIC LIBRARY',
		summary: '음악 감상과 연동되는 비주얼 인터랙션 게임',
		posterUrl: 'https://placehold.co/400x560/1a1a2e/c0c0ff?text=MUSIC+LIBRARY',
		members: [
			{ name: '테스트K', studentId: '2036001' },
		],
	},
	{
		id: 'p8', slug: 'overcome', title: 'OVERCOME',
		summary: '장애물을 극복하며 진행하는 플랫포머 게임',
		posterUrl: 'https://placehold.co/400x560/2e1a2e/ffc0ff?text=OVERCOME',
		members: [
			{ name: '테스트L', studentId: '2036002' },
			{ name: '테스트M', studentId: '2036003' },
		],
	},
	{
		id: 'p9', slug: 'gallery', title: 'GALLERY',
		summary: '미술관을 탐험하는 공포 어드벤처',
		posterUrl: 'https://placehold.co/400x560/1a2e1a/c0ffc0?text=GALLERY',
		members: [
			{ name: '테스트N', studentId: '2036004' },
			{ name: '테스트O', studentId: '2036005' },
		],
	},
	{
		id: 'p10', slug: 'diver', title: 'DIVER',
		summary: '심해 탐사 어드벤처 게임',
		posterUrl: 'https://placehold.co/400x560/2e2e1a/ffffe0?text=DIVER',
		members: [
			{ name: '테스트P', studentId: '2036006' },
			{ name: '테스트Q', studentId: '2036007' },
		],
	},
	{
		id: 'p11', slug: 'hex-defense', title: 'HEX DEFENSE',
		summary: '헥스 기반 타워 디펜스 전략 게임',
		posterUrl: 'https://placehold.co/400x560/1a2e2e/a0ffff?text=HEX+DEFENSE',
		members: [
			{ name: '테스트R', studentId: '2036008' },
		],
	},
];

const MOCK_PROJECTS_2023: PublicProjectCard[] = [
	{
		id: 'p12', slug: 'lost-bible', title: 'Lost Bible',
		summary: '고대 유적을 탐험하는 퍼즐 어드벤처',
		posterUrl: 'https://placehold.co/400x560/1a1a2e/a0a0ff?text=Lost+Bible',
		members: [
			{ name: '테스트S', studentId: '1988001' },
		],
	},
	{
		id: 'p13', slug: 'hospitalrunner', title: 'HospitalRunner',
		summary: '병원을 배경으로 한 러닝 액션 게임',
		posterUrl: 'https://placehold.co/400x560/2e1a1a/ffa0a0?text=HospitalRunner',
		members: [
			{ name: '테스트T', studentId: '1988002' },
		],
	},
	{
		id: 'p14', slug: 'what', title: 'what?!',
		summary: '비주얼 노벨 기반 추리 어드벤처',
		posterUrl: 'https://placehold.co/400x560/2e1a2e/c0a0ff?text=what%3F!',
		members: [
			{ name: '테스트U', studentId: '1988003' },
		],
	},
	{
		id: 'p15', slug: '인마대전', title: '인마대전',
		summary: '대전 격투 게임',
		posterUrl: 'https://placehold.co/400x560/1a2e1a/a0ffa0?text=%EC%9D%B8%EB%A7%88%EB%8C%80%EC%A0%84',
		members: [
			{ name: '테스트V', studentId: '1988004' },
			{ name: '테스트W', studentId: '1988005' },
		],
	},
];

const MOCK_PROJECTS_2022: PublicProjectCard[] = [
	{
		id: 'p16', slug: 'escapafe', title: "EsC'afe",
		summary: '카페를 배경으로 한 탈출 퍼즐 게임',
		posterUrl: 'https://placehold.co/400x560/2e2e1a/ffffa0?text=EsCafe',
		members: [
			{ name: '테스트X', studentId: '1888001' },
			{ name: '테스트Y', studentId: '1888002' },
		],
	},
	{
		id: 'p17', slug: 'most-puzzle', title: 'MOST PUZZLE',
		summary: '다양한 퍼즐을 조합하는 두뇌 퍼즐 게임',
		posterUrl: 'https://placehold.co/400x560/1a1a2e/8080ff?text=MOST+PUZZLE',
		members: [
			{ name: '테스트Z', studentId: '1888003' },
			{ name: '테스트AA', studentId: '1888004' },
		],
	},
	{
		id: 'p18', slug: 'v-bunny', title: 'V_BUNNY',
		summary: '토끼 캐릭터 기반 액션 플랫포머',
		posterUrl: 'https://placehold.co/400x560/2e1a1a/ff8080?text=V_BUNNY',
		members: [
			{ name: '테스트AB', studentId: '1888005' },
		],
	},
];

export const MOCK_YEAR_PROJECTS: Record<number, PublicProjectCard[]> = {
	2025: MOCK_PROJECTS_2025,
	2024: MOCK_PROJECTS_2024,
	2023: MOCK_PROJECTS_2023,
	2022: MOCK_PROJECTS_2022,
};

// ── 프로젝트 상세 빌더 ──────────────────────────────────────

function buildDetail(card: PublicProjectCard, year: number): PublicProjectDetailResponse {
	return {
		id: card.id,
		year,
		slug: card.slug,
		title: card.title,
		summary: card.summary,
		description: `${card.title}은(는) 배재대학교 게임공학과 ${year}년 졸업작품으로 제작된 프로젝트입니다.\n\n${card.summary ?? ''}\n\nPC 플랫폼 대상으로 개발되었습니다.`,
		youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
		members: card.members.map((m, i) => ({ id: `m-${card.id}-${i}`, name: m.name, studentId: m.studentId })),
		images: [
			{ id: `img-${card.id}-poster`, url: card.posterUrl ?? `https://placehold.co/800x1120/333/eee?text=${encodeURIComponent(card.title)}`, kind: 'POSTER' },
			{ id: `img-${card.id}-1`, url: `https://placehold.co/1280x720/222/ccc?text=${encodeURIComponent(card.title)}+Screenshot+1`, kind: 'IMAGE' },
			{ id: `img-${card.id}-2`, url: `https://placehold.co/1280x720/333/ccc?text=${encodeURIComponent(card.title)}+Screenshot+2`, kind: 'IMAGE' },
		],
		posterUrl: card.posterUrl,
		gameDownloadUrl: '#mock-download',
		downloadPolicy: 'PUBLIC',
		status: 'PUBLISHED',
	};
}

export function findProjectDetail(idOrSlug: string, year?: number): PublicProjectDetailResponse | undefined {
	const yearsToSearch = year ? [year] : [2025, 2024, 2023, 2022];
	for (const y of yearsToSearch) {
		const cards = MOCK_YEAR_PROJECTS[y];
		if (!cards) continue;
		const card = cards.find((c) => c.slug === idOrSlug || c.id === idOrSlug);
		if (card) return buildDetail(card, y);
	}
	return undefined;
}

// ── Admin 데이터 ─────────────────────────────────────────────

export const MOCK_ADMIN_YEARS: AdminYearItem[] = MOCK_YEARS.map((y, i) => ({
	...y,
	isUploadEnabled: i === 0,
	sortOrder: i,
	projectCount: y.projectCount,
}));

export function buildAdminProjectItems(): AdminProjectItem[] {
	const items: AdminProjectItem[] = [];
	for (const [yearStr, cards] of Object.entries(MOCK_YEAR_PROJECTS)) {
		for (const card of cards) {
			items.push({
				id: card.id, title: card.title, slug: card.slug,
				year: Number(yearStr), status: 'PUBLISHED',
				createdByUserName: '테스트', updatedAt: new Date().toISOString(),
			});
		}
	}
	return items;
}

export function buildAdminProjectDetail(id: string): AdminProjectDetail | undefined {
	const detail = findProjectDetail(id);
	if (!detail) return undefined;
	return {
		id: detail.id, title: detail.title, slug: detail.slug, year: detail.year,
		summary: detail.summary, description: detail.description, youtubeUrl: detail.youtubeUrl,
		status: 'PUBLISHED', sortOrder: 0, downloadPolicy: detail.downloadPolicy,
		posterAssetId: `img-${detail.id}-poster`, posterUrl: detail.posterUrl,
		members: detail.members.map((m, i) => ({ ...m, sortOrder: i })),
		assets: detail.images.map((img) => ({
			id: img.id, kind: img.kind, url: img.url, originalName: `${img.id}.webp`, size: 102400,
		})),
	};
}
