// Start local Vite, then run with Playwright and FFmpeg available. No production requests.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const engines = process.env.PLAYWRIGHT_MODULE_PATH ? await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href) : require('playwright');
const base = process.env.VIDEO_PLAYER_TEST_URL ?? 'http://127.0.0.1:5193';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const dir = await mkdtemp(join(tmpdir(), 'video-player-browser-'));
try {
 const media = new Map();
 for (const quality of ['max', '720p']) for (const [baseProfile, rate] of [['native', 120], ['cap60', 60], ['cap30', 30]]) {
  const profile = `${baseProfile}${quality === 'max' ? '' : '-720p'}`;
  const path = join(dir, `${profile}.mp4`);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${quality === 'max' ? '1920x1080' : '1280x720'}:rate=${rate}:duration=8`, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path]);
  media.set(profile, await readFile(path));
 }
 for (const name of (process.env.VIDEO_PLAYER_TEST_ENGINES ?? 'chromium,firefox,webkit').split(',')) {
  const browser = await engines[name].launch({ headless: true, ...(name === 'chromium' ? { args: ['--no-sandbox'] } : {}) });
  try {
   const page = await browser.newPage();
   let failNative = false;
   page.on('pageerror', error => console.error(name, error.message));
   await page.route('**/video-player-test', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module" src="/src/__tests__/helpers/video-player-browser.tsx"></script>' }));
   await page.route('**/video-test/*.mp4', route => {
    const profile = new URL(route.request().url()).pathname.split('/').pop().replace('.mp4', '');
    if (failNative && profile === 'native') return route.fulfill({ status: 404, body: 'Unavailable test rendition' });
    const bytes = media.get(profile) ?? media.get('native');
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? '');
    const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    return route.fulfill({ status: range ? 206 : 200, headers: { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': String(end - start + 1), ...(range ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}) }, body: bytes.subarray(start, end + 1) });
   });
   await page.goto(`${base}/video-player-test`);
   await page.waitForFunction(() => document.querySelector('video')?.readyState >= 1);
   async function openFrameRates() {
    await page.locator('.project-video__skin').hover();
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await page.getByRole('menuitem', { name: '프레임률', exact: true }).click();
    // Menu autofocus runs on the next frame and its popup animates into place.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.getByRole('menuitemradio', { name: '원본 프레임률 · 120fps', exact: true }).evaluate(async element => {
     await Promise.all(element.closest('.media-menu-popup').getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
    });
   }
   async function chooseFrameRate(label, keyboard = false) {
    await openFrameRates();
    const item = page.getByRole('menuitemradio', { name: label, exact: true });
    if (keyboard) {
     // Navigate the library's highlight state rather than moving DOM focus alone.
     await item.press('End');
     await page.keyboard.press('ArrowUp');
     await page.keyboard.press('Enter');
    } else await item.click();
    // Close the library menu through its own keyboard handling.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
   }
   assert.equal(await page.locator('select').count(), 0);
   assert.equal(await page.locator('video').evaluate(v => v.videoHeight), 1080);
   await openFrameRates();
   assert.equal(await page.getByRole('menuitemradio', { name: '원본 프레임률 · 120fps', exact: true }).getAttribute('aria-checked'), 'true');
   await page.keyboard.press('Escape');
   await page.keyboard.press('Escape');
   await page.getByRole('button', { name: '재생', exact: true }).first().click();
   await page.waitForFunction(() => !document.querySelector('video').paused);
   await page.getByRole('button', { name: '일시중지', exact: true }).first().click();
   await page.waitForFunction(() => document.querySelector('video').paused);
   await page.locator('video').evaluate(video => { video.pause(); video.currentTime = 3; video.volume = 0.3; video.muted = true; });
   await page.waitForFunction(() => !document.querySelector('video').seeking);
   await chooseFrameRate('60fps', true);
   await page.waitForFunction(() => { const v = document.querySelector('video'); return v.currentSrc.includes('cap60') && v.readyState >= 1 && !v.seeking && Math.abs(v.currentTime - 3) < 0.1; });
   const state = await page.locator('video').evaluate(v => ({ paused: v.paused, muted: v.muted, volume: v.volume }));
   assert.equal(state.paused, true); assert.equal(state.muted, true); assert(Math.abs(state.volume - 0.3) < 0.0001);
   await page.locator('video').evaluate(v => { v.playbackRate = 1.5; return v.play(); });
   await chooseFrameRate('30fps');
   await page.waitForFunction(() => { const v = document.querySelector('video'); return v.currentSrc.includes('cap30') && !v.paused && v.currentTime >= 2.9; });
   assert.equal(await page.locator('video').evaluate(v => v.playbackRate), 1.5);
   const beforeQuality = await page.locator('video').evaluate(v => {
    v.pause(); v.currentTime = 3;
    return { muted: v.muted, volume: v.volume, rate: v.playbackRate };
   });
   await page.locator('.project-video__skin').hover();
   await page.getByRole('button', { name: '설정', exact: true }).click();
   await page.getByRole('menuitem', { name: '화질', exact: true }).click();
   await page.getByRole('menuitemradio', { name: '720p (1280×720)', exact: true }).click();
   await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
   await page.waitForFunction(() => { const v = document.querySelector('video'); return v.currentSrc.includes('cap30-720p') && v.readyState >= 1 && !v.seeking && Math.abs(v.currentTime - 3) < 0.1; });
   const lowerQuality = await page.locator('video').evaluate(v => ({ height: v.videoHeight, paused: v.paused, muted: v.muted, volume: v.volume, rate: v.playbackRate }));
   assert.equal(lowerQuality.height, 720); assert.equal(lowerQuality.paused, true); assert.equal(lowerQuality.muted, beforeQuality.muted);
   assert(Math.abs(lowerQuality.volume - beforeQuality.volume) < 0.0001); assert.equal(lowerQuality.rate, beforeQuality.rate);
   await page.locator('video').evaluate(v => v.dispatchEvent(new Event('error')));
   await page.getByRole('alert').waitFor();
   assert.equal(await page.getByRole('link', { name: '동영상 원본 다운로드' }).count(), 1);
   await chooseFrameRate('60fps');
   await page.waitForFunction(() => document.querySelector('video').currentSrc.includes('cap60-720p'));
   assert.equal(await page.getByRole('alert').count(), 0);
   if (process.env.VIDEO_PLAYER_ARTIFACT_DIR) {
    await mkdir(process.env.VIDEO_PLAYER_ARTIFACT_DIR, { recursive: true });
    for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
     await page.setViewportSize({ width, height: 900 });
     await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
     assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
     await page.screenshot({ path: join(process.env.VIDEO_PLAYER_ARTIFACT_DIR, `${name}-${width}-${theme}.png`), fullPage: true });
     await openFrameRates();
     const menu = page.getByRole('menuitemradio', { name: '원본 프레임률 · 120fps', exact: true });
     await menu.waitFor({ state: 'visible' });
     const bounds = await menu.boundingBox();
     await page.screenshot({ path: join(process.env.VIDEO_PLAYER_ARTIFACT_DIR, `${name}-${width}-${theme}-fps-menu.png`), fullPage: true });
     assert(bounds.x >= 0 && bounds.x + bounds.width <= width);
     await page.keyboard.press('Escape');
     await page.keyboard.press('Escape');
    }
   }
   failNative = true;
   await page.reload();
   await page.getByRole('alert').filter({ hasText: '영상을 불러올 수 없습니다.' }).waitFor();
   // A library error dialog can be dismissed before choosing another MP4 rendition.
   const dismiss = page.getByRole('button', { name: '닫기', exact: true });
   if (await dismiss.isVisible()) await dismiss.click();
   await chooseFrameRate('60fps');
   await page.waitForFunction(() => { const v = document.querySelector('video'); return v.currentSrc.includes('cap60') && v.readyState >= 1; });
   assert.equal(await page.getByRole('alert').filter({ hasText: '영상을 불러올 수 없습니다.' }).count(), 0);
   console.log(`${name}: native default, paused/playing switch, position, volume, mute, library settings, keyboard, 720p switch preserving FPS, real 404 recovery PASS`);
  } finally { await browser.close(); }
 }
} finally { await rm(dir, { recursive: true, force: true }); }
