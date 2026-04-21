// Shared API contract types between apps/api and apps/web.
// Type-only — no runtime values. Each consumer declares its own runtime
// constants (e.g. enum value arrays for form options) where needed.

// ── Enums ────────────────────────────────────────────────────

export type UserRole = 'USER' | 'OPERATOR' | 'ADMIN';
export type ProjectStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export type AssetKind = 'THUMBNAIL' | 'IMAGE' | 'POSTER' | 'GAME' | 'VIDEO';

// ── Auth ─────────────────────────────────────────────────────

/** POST /api/auth/google – request */
export type GoogleAuthRequest = {
	credential: string;
};

/** Authenticated user */
export type AuthUser = {
	id: number;
	email: string;
	name: string;
	role: UserRole;
};

/** POST /api/auth/google – response (data envelope stripped) */
export type GoogleAuthResponse = {
	user: AuthUser;
};

/** POST /api/auth/logout – response */
export type LogoutResponse = { message: string };

/** GET /api/me – response */
export type MeResponse =
	| { authenticated: false }
	| { authenticated: true; user: AuthUser };

// ── Public ───────────────────────────────────────────────────

/** GET /api/public/years */
export type PublicYearItem = {
	id: number;
	year: number;
	title?: string;
	projectCount: number;
};

export type PublicYearListResponse = {
	items: PublicYearItem[];
};

/** GET /api/public/years/:year/projects */
export type PublicProjectCard = {
	id: number;
	slug: string;
	title: string;
	summary?: string;
	posterUrl?: string;
	members: { name: string; studentId: string }[];
	exhibitionId?: number;
	exhibitionTitle?: string;
};

export type PublicExhibition = {
	id: number;
	title: string;
};

export type PublicYearProjectsResponse = {
	year: number;
	exhibitions: PublicExhibition[];
	items: PublicProjectCard[];
	empty: boolean;
};

/** GET /api/public/exhibitions/:id/projects */
export type PublicExhibitionProjectsResponse = {
	exhibition: { id: number; year: number; title: string };
	items: PublicProjectCard[];
	empty: boolean;
};

/** Project video (locally uploaded) */
export type ProjectVideo = {
	url: string;
	mimeType: string;
};

/** GET /api/public/projects/:idOrSlug */
export type PublicProjectImage = {
	id: number;
	url: string;
	kind: 'IMAGE' | 'POSTER';
};

export type PublicProjectMember = {
	id: number;
	name: string;
	studentId: string;
};

export type PublicProjectDetailResponse = {
	id: number;
	year: number;
	slug: string;
	title: string;
	summary?: string;
	description?: string;
	isIncomplete: boolean;
	video: ProjectVideo | null;
	members: PublicProjectMember[];
	images: PublicProjectImage[];
	posterUrl?: string;
	gameDownloadUrl?: string;
	status: 'PUBLISHED';
};

// ── Admin: Exhibition ────────────────────────────────────────

export type CreateExhibitionRequest = {
	year: number;
	title?: string;
	isUploadEnabled?: boolean;
	sortOrder?: number;
};

export type UpdateExhibitionRequest = {
	title?: string;
	isUploadEnabled?: boolean;
	sortOrder?: number;
};

export type AdminExhibitionItem = {
	id: number;
	year: number;
	title?: string;
	isUploadEnabled: boolean;
	sortOrder: number;
	projectCount: number;
};

// ── Admin: Project ───────────────────────────────────────────

export type UpdateProjectRequest = {
	title?: string;
	summary?: string;
	description?: string;
	isIncomplete?: boolean;
	status?: ProjectStatus;
	sortOrder?: number;
};

export type AdminProjectItem = {
	id: number;
	title: string;
	slug: string;
	year: number;
	isIncomplete: boolean;
	status: ProjectStatus;
	createdByUserName?: string;
	memberNames: string[];
	updatedAt: string;
};

export type AdminProjectDetail = {
	id: number;
	title: string;
	slug: string;
	year: number;
	summary?: string;
	description?: string;
	isIncomplete: boolean;
	video: ProjectVideo | null;
	status: ProjectStatus;
	sortOrder: number;
	posterAssetId?: number;
	posterUrl?: string;
	members: { id: number; name: string; studentId: string; sortOrder: number; userId: number | null }[];
	assets: {
		id: number;
		kind: AssetKind;
		url: string;
		originalName: string;
		size: number;
	}[];
};

// ── Admin: Submit (all-in-one) ───────────────────────────────

export type SubmitProjectPayload = {
	exhibitionId: number;
	title: string;
	summary?: string;
	description?: string;
	members: { name: string; studentId: string; sortOrder?: number }[];
	autoPublish?: boolean;
};

export type SubmitProjectResponse = {
	id: number;
	slug: string;
	year: number;
	status: 'DRAFT' | 'PUBLISHED';
	adminEditUrl: string;
	publicUrl?: string;
};

// ── Admin: Member CRUD ───────────────────────────────────────

export type AddMemberRequest = {
	name: string;
	studentId: string;
	sortOrder?: number;
};

export type UpdateMemberRequest = {
	name?: string;
	studentId?: string;
	sortOrder?: number;
};
