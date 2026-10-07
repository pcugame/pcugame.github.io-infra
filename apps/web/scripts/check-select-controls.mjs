/**
 * Native select enhancement/fallback checks against the local mock Vite server.
 * Run like check-ui-styles.mjs. EXPECT_ENHANCEMENT=1 (support) or 0 (fallback)
 * verifies actual browser capabilities; no CSS.supports stub or forced override.
 * SCREENSHOT_DIR optionally saves each open menu. No production writes.
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const engine = process.env.BROWSER_ENGINE || 'chromium';
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:15185';
const executablePath = process.env.BROWSER_PATH || process.env.CHROMIUM_PATH;
const browser = await playwright[engine].launch({
  ...(executablePath ? { executablePath } : {}),
  args: engine === 'chromium' ? ['--no-sandbox'] : [],
});
const screenshotDir = process.env.SCREENSHOT_DIR;
if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
try {
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    await page.route(`${base}/__select-probe`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }));
    await page.goto(`${base}/__select-probe`);
    await page.setContent(`<html data-theme="${theme}"><head><link rel="stylesheet" href="${base}/src/styles/index.css"></head>
      <body><main style="padding:1rem;max-width:30rem;margin:auto"><form id="form">
        <div style="height:5rem;overflow:hidden" class="admin-card">
          <label for="choice">Choice</label>
          <select id="choice" class="form-control" name="choice" required>
            <option value="" selected disabled>Choose an option</option>
            <option value="a">2026 · 전시회</option><option value="b">2025 · 전시회 · 업로드 잠김</option>
            <option value="disabled" disabled>Unavailable</option>
          </select>
        </div>
        <button type="submit">Submit</button><button type="reset">Reset</button>
        <fieldset disabled><select class="form-control" name="disabled"><option>Disabled fieldset</option></select></fieldset>
        <select class="form-control" multiple name="multiple"><option selected>A</option><option>B</option></select>
        <select class="form-control" size="2"><option>A</option><option>B</option></select>
      </form></main></body></html>`);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#choice')).borderRadius === '10px');
    const supported = await page.evaluate(() => CSS.supports('appearance', 'base-select') && CSS.supports('selector(::picker(select))'));
    if (process.env.EXPECT_ENHANCEMENT !== undefined) assert.equal(supported, process.env.EXPECT_ENHANCEMENT === '1');
    const choice = page.locator('#choice');
    assert.equal(await choice.evaluate(el => getComputedStyle(el).appearance), supported ? 'base-select' : 'none');
    assert.equal(await choice.evaluate(el => el.checkValidity()), false);
    await page.evaluate(() => {
      window.submitted = null;
      document.querySelector('form').addEventListener('submit', event => {
        event.preventDefault(); window.submitted = Object.fromEntries(new FormData(event.target));
      });
    });
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    assert.equal(await page.evaluate(() => window.submitted), null);
    await choice.click();
    if (supported) {
      // Top-layer picker must escape even an overflow:hidden ancestor.
      const option = page.getByRole('option', { name: '2025 · 전시회 · 업로드 잠김' });
      await option.waitFor({ state: 'visible' });
      assert.equal(await option.evaluate(el => {
        const r = el.getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      }), true);
    }
    if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/${engine}-${width}-${theme}.png` });
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    assert.equal(await choice.inputValue(), 'b'); // Skips the disabled last option.
    await choice.click();
    await page.keyboard.press('Escape');
    assert.equal(await choice.inputValue(), 'b');
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.submitted), { choice: 'b', multiple: 'A' });
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    assert.equal(await choice.inputValue(), '');
    assert.equal(await choice.evaluate(el => el.checkValidity()), false);
    assert.equal(await page.locator('[name="disabled"]').isDisabled(), true);
    for (const selector of ['select[multiple]', 'select[size]']) {
      assert.notEqual(await page.locator(selector).evaluate(el => getComputedStyle(el).appearance), 'base-select');
    }
    await page.emulateMedia({ forcedColors: 'active' });
    assert.equal(await choice.evaluate(el => getComputedStyle(el).appearance), 'auto');
    assert.equal(await choice.evaluate(el => getComputedStyle(el).backgroundImage), 'none');
    await choice.selectOption('a');
    assert.equal(await choice.inputValue(), 'a');
    console.log(`PASS ${engine} ${browser.version()}: ${width}px ${theme}, enhancement=${supported}, native submit/reset/validation/disabled/forced-colors`);
    await page.close();
  }
} finally { await browser.close(); }
