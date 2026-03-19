// ── Auth API 호출 ────────────────────────────────────────────

import type {
  GoogleAuthRequest,
  GoogleAuthResponse,
  LogoutResponse,
  MeResponse,
} from '../../contracts';
import { api } from './client';

export const authApi = {
  /** Google ID token으로 로그인 */
  loginWithGoogle(credential: string) {
    return api.post<GoogleAuthResponse>('/api/auth/google', {
      credential,
    } satisfies GoogleAuthRequest);
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
