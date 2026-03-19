// ── 환경 변수 접근 계층 ──────────────────────────────────────
// Vite는 import.meta.env.VITE_* 형태로 환경 변수를 주입한다.

export const env = {
  /** 백엔드 API 기본 URL (예: https://api.gradshow.pcu.ac.kr) */
  API_BASE_URL: import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000',

  /** Google OAuth Client ID */
  GOOGLE_CLIENT_ID: import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '',

  /** GitHub Pages base path (커스텀 도메인이면 '/') */
  BASE_PATH: import.meta.env.BASE_URL ?? '/',
} as const;
