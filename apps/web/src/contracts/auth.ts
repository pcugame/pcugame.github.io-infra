// ── Auth API 타입 ────────────────────────────────────────────

import type { UserRole } from './enums';

/** POST /api/auth/google – 요청 */
export type GoogleAuthRequest = {
  credential: string;
};

/** POST /api/auth/google – 응답 (envelope 제거 후 data 내부) */
export type GoogleAuthResponse = {
  user: AuthUser;
};

/** POST /api/auth/logout – 응답 */
export type LogoutResponse = { message: string };

/** GET /api/me – 응답 */
export type MeResponse =
  | { authenticated: false }
  | { authenticated: true; user: AuthUser };

/** 인증된 사용자 정보 */
export type AuthUser = {
  id: number;
  email: string;
  name: string;
  role: UserRole;
};
