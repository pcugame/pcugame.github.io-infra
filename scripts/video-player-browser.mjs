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
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${quality === 'max' ? '1920x1080' : '1280x720'}:rate=${rate}:duration=8`, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-c:a', 'aac', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path]);
  media.set(profile, await readFile(path));
 }
 for (const name of (process.env.VIDEO_PLAYER_TEST_ENGINES ?? 'chromium,firefox,webkit').split(',')) {
  const browser = await engines[name].launch({ headless: true, executablePath: process.env[`VIDEO_PLAYER_${name.toUpperCase()}_EXECUTABLE`], ...(name === 'chromium' ? { args: ['--no-sandbox', '--autoplay-policy=user-gesture-required'] } : {}) });
  try {
   const page = await browser.newPage();
   let failNative = false;
   async function preparePage(page) {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/video-player-test*', route => route.fulfill({ contentType: 'text/html', body: '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module" src="/src/__tests__/helpers/video-player-browser.tsx"></script>' }));
    await page.route('**/video-test/*.mp4', route => {
     const profile = new URL(route.request().url()).pathname.split('/').pop().replace('.mp4', '');
     if (failNative && profile === 'native') return route.fulfill({ status: 404, body: 'Unavailable test rendition' });
     const bytes = media.get(profile) ?? media.get('native');
     const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? '');
     const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
     return route.fulfill({ status: range ? 206 : 200, headers: { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': String(end - start + 1), ...(range ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}) }, body: bytes.subarray(start, end + 1) });
    });
    return errors;
   }
   const desktopErrors = await preparePage(page);
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
   assert.deepEqual(desktopErrors, []);
   failNative = false;
   // Exercise the real project modal with touch input, not just a narrow desktop viewport.
   if (name !== 'firefox') for (const viewport of [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    const mobile = await browser.newPage({ viewport, hasTouch: true, isMobile: true });
    try {
     const mobileErrors = await preparePage(mobile);
     await mobile.goto(`${base}/video-player-test?modal`);
     const surface = mobile.locator('.project-video__surface');
     const centerPlay = mobile.locator('.project-video__center-play');
     await centerPlay.tap();
     await mobile.waitForFunction(() => { const v = document.querySelector('video'); return v && !v.paused && v.currentTime > 0; });
     await mobile.locator('video').evaluate(v => { v.loop = true; });
     assert.equal(await mobile.locator('video').evaluate(v => v.muted), false);
     const closeBounds = await mobile.locator('.modal-panel--project > .modal-close').boundingBox();
     const videoBounds = await surface.boundingBox();
     const contentBounds = await mobile.locator('.modal-content').boundingBox();
     assert.equal(await mobile.locator('.modal-toolbar').count(), 0, 'no separate header above the media');
     assert(Math.abs(videoBounds.y - contentBounds.y) < 2, 'media starts at the top of the content');
     assert(closeBounds.y >= videoBounds.y && closeBounds.y < videoBounds.y + videoBounds.height, 'close overlays the existing media');
     assert.equal(await mobile.getByRole('link', { name: '동영상 원본 다운로드' }).count(), 0, 'no download action during normal playback');
     assert(Math.abs(videoBounds.height - Math.min(videoBounds.width * 9 / 16, viewport.height * 0.7)) < 2, 'downloads must not shrink the video');
     assert(closeBounds.width >= 44 && closeBounds.height >= 44, 'close touch target');
     async function showControls() {
      if (await mobile.locator('.project-video__skin').getAttribute('data-controls-visible') === null) await mobile.locator('video').tap();
     }
     async function dismissMenu() {
      await mobile.locator('.modal-video-label').tap();
     }
     await showControls();
     await mobile.getByRole('button', { name: '설정', exact: true }).tap();
     await mobile.getByRole('menuitem', { name: '화질', exact: true }).tap();
     const quality = mobile.getByRole('menuitemradio', { name: '720p (1280×720)', exact: true });
     await quality.evaluate(async element => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await Promise.all(element.closest('.media-menu-popup').getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
     });
     const qualityBounds = await quality.boundingBox();
     assert(qualityBounds.x >= 0 && qualityBounds.x + qualityBounds.width <= viewport.width, 'quality menu fits viewport');
     const triggerBounds = await mobile.getByRole('button', { name: '설정', exact: true }).boundingBox();
     const popupBounds = await mobile.locator('.media-menu-popup[data-open]').boundingBox();
     assert(Math.abs(popupBounds.x + popupBounds.width - triggerBounds.x - triggerBounds.width) < 2, 'quality popup aligns with settings trigger end');
     assert(popupBounds.y + popupBounds.height <= triggerBounds.y + 1, 'quality popup is above settings trigger');
     await quality.tap();
     await mobile.waitForFunction(() => document.querySelector('video').currentSrc.includes('native-720p'));
     await dismissMenu();
     await showControls();
     await mobile.getByRole('button', { name: '설정', exact: true }).tap();
     await mobile.getByRole('menuitem', { name: '프레임률', exact: true }).tap();
     await mobile.getByRole('menuitemradio', { name: '30fps', exact: true }).tap();
     await mobile.waitForFunction(() => document.querySelector('video').currentSrc.includes('cap30-720p'));
     await dismissMenu();
     await mobile.waitForFunction(() => document.querySelector('video').readyState >= 1);
     if (await mobile.locator('video').evaluate(v => v.paused)) await centerPlay.tap();
     await mobile.waitForFunction(() => !document.querySelector('video').paused);
     await showControls();
     await mobile.getByRole('button', { name: '일시중지', exact: true }).tap();
     await mobile.waitForFunction(() => document.querySelector('video').paused);
     await centerPlay.tap();
     await mobile.waitForFunction(() => !document.querySelector('video').paused);
     await showControls();
     const fullscreen = mobile.locator('.media-fullscreen-button');
     for (const button of await mobile.locator('.video-controls-secondary .media-button').all()) {
      if (!await button.isVisible()) continue;
      const bounds = await button.boundingBox();
      assert(bounds.width >= 44 && bounds.height >= 44, 'player touch target');
      assert(bounds.x + bounds.width <= closeBounds.x || bounds.y >= closeBounds.y + closeBounds.height || bounds.y + bounds.height <= closeBounds.y, 'player controls must not overlap close');
     }
     if (await fullscreen.count() > 0 && await fullscreen.getAttribute('data-availability') === 'available') {
      await fullscreen.tap();
      await mobile.waitForFunction(() => document.querySelector('.media-fullscreen-button')?.hasAttribute('data-fullscreen'));
      await showControls();
      await mobile.getByRole('button', { name: '전체 화면 종료', exact: true }).tap();
      await mobile.waitForFunction(() => !document.querySelector('.media-fullscreen-button')?.hasAttribute('data-fullscreen'));
     }
     await showControls();
     await mobile.getByRole('button', { name: '설정', exact: true }).tap();
     await mobile.keyboard.press('Escape');
     assert.equal(await mobile.locator('.modal-panel--project').count(), 1, 'menu Escape must not dismiss the modal');
     await mobile.keyboard.press('m');
     assert.equal(await mobile.locator('.modal-panel--project').count(), 1, 'player hotkeys must not dismiss the modal');
     assert.equal(await mobile.getByRole('alert').count(), 0);
     if (process.env.VIDEO_PLAYER_ARTIFACT_DIR) {
      await mobile.screenshot({ path: join(process.env.VIDEO_PLAYER_ARTIFACT_DIR, `${name}-touch-${viewport.width}.png`), fullPage: true });
     }
     await showControls();
     await mobile.getByRole('button', { name: '설정', exact: true }).tap();
     await dismissMenu();
     await mobile.locator('.modal-panel--project > .modal-close').tap();
     await mobile.getByText('작품 닫힘').waitFor();
     assert.equal(await mobile.locator('video').count(), 0);
     assert.deepEqual(mobileErrors, []);
     console.log(`${name}: touch ${viewport.width}x${viewport.height}, audible first play, modal controls, quality/FPS, pause/resume, close PASS`);
    } finally { await mobile.close(); }
   }
   console.log(`${name}: native default, paused/playing switch, position, volume, mute, library settings, keyboard, 720p switch preserving FPS, real 404 recovery PASS`);
  } finally { await browser.close(); }
 }
} finally { await rm(dir, { recursive: true, force: true }); }
