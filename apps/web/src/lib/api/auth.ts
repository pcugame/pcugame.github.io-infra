// ── Auth API 호출 ────────────────────────────────────────────

import type {
  DevAuthErrorScenario,
  DevAuthLoginErrorRequest,
  DevAuthLoginRequest,
  GoogleAuthRequest,
  GoogleAuthResponse,
  LogoutResponse,
  MeResponse,
  UserRole,
} from '../../contracts';
import { api } from './client';

export type { DevAuthErrorScenario };

export const authApi = {
  /** Google ID token으로 로그인 */
  loginWithGoogle(credential: string) {
    return api.post<GoogleAuthResponse>('/api/auth/google', {
      credential,
    } satisfies GoogleAuthRequest);
  },

  /** dev/test 전용 역할 로그인 */
  loginWithDevRole(role: UserRole) {
    return api.post<GoogleAuthResponse>('/api/dev/auth/login', {
      role,
    } satisfies DevAuthLoginRequest);
  },

  /** dev/test 전용 로그인 실패 시뮬레이션 */
  simulateDevLoginError(scenario: DevAuthErrorScenario) {
    return api.post<GoogleAuthResponse>('/api/dev/auth/login-error', {
      scenario,
    } satisfies DevAuthLoginErrorRequest);
  },

  /** 로그아웃 */
  logout() {
    return api.post<LogoutResponse>('/api/auth/logout');
  },

  /** 현재 세션 확인 */
  me() {
    return api.get<MeResponse>('/api/me');
  },
};
