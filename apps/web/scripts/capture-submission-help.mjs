/**
 * Capture the real mock submission UI; never clicks submit or touches production.
 * Start Vite separately: VITE_MOCK=true npm exec --workspace apps/web vite -- --host 127.0.0.1 --port 4178
 * PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs CHROMIUM_PATH=/path/to/chromium node apps/web/scripts/capture-submission-help.mjs
 * Optional CAPTURE_BASE_URL (defaults http://127.0.0.1:4178).
 * Playwright is external capture tooling, deliberately not a project dependency.
 */
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const playwrightModule = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(playwrightModule);
const output = fileURLToPath(new URL('../public/help/project-submission/', import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  headless: true, args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, deviceScaleFactor: 2, colorScheme: 'light', locale: 'ko-KR' });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => localStorage.setItem('mock-role', 'USER'));
await page.goto(`${process.env.CAPTURE_BASE_URL || 'http://127.0.0.1:4178'}/me/projects/new`);
await page.getByRole('button', { name: '포스터 파일 선택', exact: true }).waitFor();
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);

async function box(locator) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error('Capture target missing');
  return bounds;
}
async function capture(name, region, targets, number) {
  await page.evaluate(() => document.querySelectorAll('[data-capture-annotation]').forEach(element => element.remove()));
  const targetBounds = await Promise.all(targets.map(box));
  await page.evaluate(({ targetBounds, number }) => {
    const color = getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim() || '#1a51af';
    for (const bounds of targetBounds) {
      const overlay = document.createElement('div');
      overlay.setAttribute('data-capture-annotation', '');
      Object.assign(overlay.style, { position: 'absolute', left: `${bounds.x + scrollX - 5}px`, top: `${bounds.y + scrollY - 5}px`, width: `${bounds.width + 10}px`, height: `${bounds.height + 10}px`, border: `3px dashed ${color}`, borderRadius: '10px', boxSizing: 'border-box', zIndex: '99999', pointerEvents: 'none' });
      const badge = document.createElement('span');
      badge.textContent = String(number);
      Object.assign(badge.style, { position: 'absolute', left: '-16px', top: '-17px', width: '30px', height: '30px', borderRadius: '50%', background: color, color: '#fff', border: '2px solid white', display: 'grid', placeItems: 'center', font: '700 18px Pretendard, sans-serif', boxShadow: '0 1px 4px #0003' });
      overlay.append(badge); document.body.append(overlay);
    }
  }, { targetBounds, number });
  const clip = { x: Math.floor(region.x), y: Math.floor(region.y), width: Math.ceil(region.width), height: Math.ceil(region.height) };
  const png = await page.screenshot({ clip, animations: 'disabled' });
  await sharp(png).webp({ quality: 92 }).toFile(resolve(output, `${name}.webp`));
  console.log(name, clip);
  await page.evaluate(() => document.querySelectorAll('[data-capture-annotation]').forEach(element => element.remove()));
}

const poster = page.locator('.project-upload-drop--poster');
const posterBrowse = poster.locator('.project-upload-drop__browse');
const posterBounds = await box(poster);
const posterPrompt = await box(poster.locator('.project-upload-drop__prompt'));
await capture('poster-select', { x: posterBounds.x - 10, y: posterPrompt.y - 36, width: posterBounds.width + 20, height: posterBounds.y + posterBounds.height - posterPrompt.y + 46 }, [posterBrowse], 1);

const files = page.locator('.project-upload-drop--files');
const filesBounds = await box(files);
const filesIcon = await box(files.locator('.project-upload-drop__icon'));
const filesHint = await box(files.locator('.project-upload-drop__select .field-hint'));
await capture('files-select', { x: filesBounds.x - 10, y: filesIcon.y - 20, width: filesBounds.width + 20, height: filesHint.y + filesHint.height - filesIcon.y + 42 }, [files.locator('.project-upload-drop__browse')], 1);

// A valid empty ZIP: fixture filenames only; no real student/project data.
const zip = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
await files.locator('input[type=file]').setInputFiles([
  { name: 'game.zip', mimeType: 'application/zip', buffer: zip },
  { name: 'webgl.zip', mimeType: 'application/zip', buffer: zip },
]);
const queue = files.locator('.project-upload-queue');
await queue.getByText('game.zip', { exact: true }).waitFor();
let bounds = await box(queue);
await capture('zip-purpose', { x: bounds.x - 28, y: bounds.y - 8, width: bounds.width + 56, height: bounds.height + 9 }, [queue.locator('li').filter({ hasText: 'game.zip' }).getByRole('button', { name: '게임', exact: true }), queue.locator('li').filter({ hasText: 'webgl.zip' }).getByRole('button', { name: 'WebGL', exact: true })], 2);
await queue.locator('li').filter({ hasText: 'game.zip' }).getByRole('button', { name: '게임', exact: true }).click();
await queue.locator('li').filter({ hasText: 'webgl.zip' }).getByRole('button', { name: 'WebGL', exact: true }).click();
await page.getByRole('button', { name: '작품 제출', exact: true }).waitFor({ state: 'visible' });
bounds = await box(queue);
await capture('files-review', { x: bounds.x - 28, y: bounds.y - 8, width: bounds.width + 56, height: bounds.height + 9 }, [queue.getByRole('button', { name: '선택 취소', exact: true }).first()], 3);

await page.locator('#title').fill('예시 작품: 별빛 탐험');
await page.locator('#summary').fill('파일 선택 안내를 위한 예시 작품입니다.');
await page.locator('#description').fill('이 화면은 사용 방법을 보여 주기 위한 예시입니다. 실제 작품을 제출하지 않습니다.');
await page.locator('[name="members.0.name"]').fill('예시 학생');
await page.locator('[name="members.0.studentId"]').fill('00000000');
await page.locator('#title').evaluate(() => document.activeElement?.blur());
const members = page.locator('.admin-project-edit-details fieldset').filter({ has: page.getByText('참여 학생 *', { exact: true }) });
const memberBounds = await box(members);
const actions = await box(page.locator('.form-actions'));
await capture('submit-action', { x: actions.x - 28, y: memberBounds.y - 10, width: actions.width + 56, height: actions.y + actions.height - memberBounds.y + 28 }, [page.getByRole('button', { name: '작품 제출', exact: true })], 4);
if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
console.log('Captured with', browser.version(), 'at', page.url(), 'font status', await page.evaluate(() => document.fonts.status));
await browser.close();
