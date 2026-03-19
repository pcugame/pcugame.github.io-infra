import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // GitHub Pages: 커스텀 도메인이면 '/', 리포지토리 서브패스이면 '/repo-name/'
  // VITE_BASE_PATH 환경변수로 오버라이드 가능
  base: process.env.VITE_BASE_PATH ?? '/',
});
