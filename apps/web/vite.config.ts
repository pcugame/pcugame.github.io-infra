import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'tbh-never-build-for-publication',
      apply: 'build',
      buildStart() {
        this.error('TBH_NON_PRODUCTION_ONLY: this variant must never be built or deployed. Use dev:mock for local preview.');
      },
    },
  ],
  test: {
    // Node 26 Web Storage globals shadow jsdom's browser Storage implementation.
    execArgv: ['--no-webstorage'],
  },
  // GitHub Pages: 커스텀 도메인이면 '/', 리포지토리 서브패스이면 '/repo-name/'
  // VITE_BASE_PATH 환경변수로 오버라이드 가능
  base: process.env.VITE_BASE_PATH ?? '/',
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        webglGuide: fileURLToPath(new URL('./unity-webgl-guide/index.html', import.meta.url)),
      },
    },
  },
  server: {
    allowedHosts: process.env.VITE_ALLOWED_HOSTS
      ?.split(',')
      .map((host) => host.trim())
      .filter(Boolean),
  },
});
