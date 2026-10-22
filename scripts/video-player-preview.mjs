// Local, disposable player preview. No production DB, uploads, or remote media.
import { createServer } from 'vite';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../apps/web/', import.meta.url));
const mediaRoot = await mkdtemp(join(tmpdir(), 'pcu-video-player-preview-'));
let server;
try {
 for (const quality of ['max', '720p']) for (const [baseProfile, frameRate] of [['native', 120], ['cap60', 60], ['cap30', 30]]) {
  const profile = `${baseProfile}${quality === 'max' ? '' : '-720p'}`;
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${quality === 'max' ? '1920x1080' : '1280x720'}:rate=${frameRate}:duration=12`,
   '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(mediaRoot, `${profile}.mp4`)], { stdio: 'inherit' });
 }
 server = await createServer({ root, configFile: resolve(root, 'vite.config.ts'), server: { host: '127.0.0.1', port: 5193, strictPort: true },
  plugins: [{ name: 'local-video-player-preview', configureServer(vite) {
   vite.middlewares.use(async (request, response, next) => {
    try {
     const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
     if (pathname === '/video-player-test') {
      const html = await vite.transformIndexHtml(pathname, '<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Video.js 플레이어 미리보기</title></head><body><div id="root"></div><script type="module" src="/src/__tests__/helpers/video-player-browser.tsx"></script></body></html>');
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(html); return;
     }
     const match = /^\/video-test\/(native(?:-720p)?|cap60(?:-720p)?|cap30(?:-720p)?|original)\.mp4$/.exec(pathname);
     if (!match) { next(); return; }
     const path = join(mediaRoot, `${match[1] === 'original' ? 'native' : match[1]}.mp4`);
     const { size } = await stat(path);
     const range = request.headers.range;
     const parts = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
     const start = parts ? Number(parts[1]) : 0;
     const end = parts?.[2] ? Math.min(Number(parts[2]), size - 1) : size - 1;
     if ((range && !parts) || start >= size || start > end) { response.writeHead(416, { 'Content-Range': `bytes */${size}` }); response.end(); return; }
     response.writeHead(parts ? 206 : 200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
      ...(parts ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}), ...(match[1] === 'original' ? { 'Content-Disposition': 'attachment; filename="test-original.mp4"' } : {}) });
     if (request.method === 'HEAD') { response.end(); return; }
     const stream = createReadStream(path, { start, end });
     response.on('close', () => stream.destroy()); stream.on('error', () => response.destroy()); stream.pipe(response);
    } catch (error) { next(error); }
   });
  } }],
 });
 await server.listen();
 console.log('Video.js preview: http://127.0.0.1:5193/video-player-test');
 let closing = false;
 const close = async () => { if (closing) return; closing = true; await server.close(); await rm(mediaRoot, { recursive: true, force: true }); process.exit(0); };
 process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());
} catch (error) {
 await server?.close(); await rm(mediaRoot, { recursive: true, force: true }); throw error;
}
