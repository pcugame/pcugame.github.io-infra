import { loadRuntimeConfig } from './lib/env/runtime-config';

async function start() {
  try {
    if (import.meta.env.VITE_RUNTIME_CONFIG === 'true') await loadRuntimeConfig();
    // Import the application only after config is ready: API clients and routes
    // read env during module initialization.
    await import('./bootstrap');
  } catch {
    const root = document.getElementById('root');
    if (root) {
      root.setAttribute('role', 'alert');
      root.textContent = '웹 구성 오류: 공개 설정 파일 또는 앱을 불러올 수 없습니다. 운영자에게 문의하십시오.';
    }
  }
}

void start();
