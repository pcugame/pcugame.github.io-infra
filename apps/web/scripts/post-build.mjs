/**
 * GitHub Pages SPA fallback:
 * index.html을 404.html로 복사하여 deep-link 404 문제를 해결한다.
 *
 * GitHub Pages는 존재하지 않는 경로 요청 시 404.html을 반환하는데,
 * 이 파일이 index.html과 동일하면 SPA 라우터가 정상 작동한다.
 */

import { copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = resolve(__dirname, '..', 'dist');

copyFileSync(resolve(dist, 'index.html'), resolve(dist, '404.html'));
console.log('✓ 404.html created (SPA fallback for GitHub Pages)');
