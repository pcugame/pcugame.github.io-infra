/**
 * Shared form CSS browser checks. No API calls or production writes.
 * Start: npm exec --workspace apps/web vite -- --mode mock --host 127.0.0.1 --port 15185
 * Run: PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node apps/web/scripts/check-ui-styles.mjs
 * Optional UI_BASE_URL (default http://127.0.0.1:15185), CHROMIUM_PATH.
 * Playwright is external verification tooling, not an application dependency.
 */
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

const base = process.env.UI_BASE_URL || 'http://127.0.0.1:15185';
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox'],
});

try {
  // Test the public CSS contract in isolation from page ancestors and feature layouts.
  // Component behavior and accessible associations are covered by UiPrimitives.test.tsx.
  for (const width of [1440, 390]) {
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      // Keep the probe independent of app startup, mock API calls and Vite HMR.
      await page.route(`${base}/__ui-style-probe`, route => route.fulfill({
        contentType: 'text/html', body: '<!doctype html><html><head></head><body></body></html>',
      }));
      await page.goto(`${base}/__ui-style-probe`);
      await page.setContent(`
        <html data-theme="${theme}"><head>
          <link rel="stylesheet" href="${base}/src/styles/index.css">
        </head><body><main style="padding:1rem;max-width:40rem;margin:auto">
          <fieldset class="form-section">
            <legend>Shared controls</legend>
            <div class="form-field"><label class="form-field__label" for="title">Title</label>
              <input class="form-control" id="title" value="Sample title"></div>
            <div class="form-field"><label class="form-field__label" for="email">Email</label>
              <input class="form-control" id="email" type="email"></div>
            <div class="form-field"><label class="form-field__label" for="select">Select</label>
              <select class="form-control" id="select"><option>Sample option</option></select></div>
            <div class="form-field"><label class="form-field__label" for="description">Description</label>
              <textarea class="form-control" id="description">Sample description</textarea></div>
            <div class="form-field"><label class="form-choice"><input type="checkbox">Enabled</label></div>
            <div class="form-field"><label class="form-field--checkbox"><input type="checkbox">Legacy label</label></div>
            <div class="form-field form-field--checkbox"><label><input type="checkbox">Legacy wrapper</label></div>
            <input class="form-control" id="standalone" type="email" aria-label="Standalone field">
            <div class="form-actions"><button type="button" class="btn btn--primary">Save</button></div>
          </fieldset>
        </main></body></html>`);
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.form-section')).borderRadius === '12px');
      const styles = await page.evaluate(() => {
        const field = document.querySelector('#title');
        const titleStyle = getComputedStyle(field);
        const sectionStyle = getComputedStyle(document.querySelector('.form-section'));
        const controlIds = ['title', 'email', 'select', 'description', 'standalone'];
        return {
          rootFont: getComputedStyle(document.documentElement).fontSize,
          controlFonts: controlIds.map(id => getComputedStyle(document.getElementById(id)).fontSize),
          backgrounds: controlIds.map(id => getComputedStyle(document.getElementById(id)).backgroundColor),
          selectArrow: getComputedStyle(document.querySelector('#select')).backgroundImage,
          choiceDisplays: [...document.querySelectorAll('.form-choice, label.form-field--checkbox, .form-field--checkbox > label')].map(el => getComputedStyle(el).display),
          sectionBorder: sectionStyle.borderTopStyle,
          fieldBorder: titleStyle.borderTopStyle,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      assert.equal(styles.rootFont, width === 390 ? '16px' : '20px');
      assert.ok(styles.controlFonts.every(value => value === (width === 390 ? '16px' : '18px')), JSON.stringify(styles));
      assert.ok(styles.backgrounds.every(value => value === styles.backgrounds[0]), JSON.stringify(styles));
      assert.notEqual(styles.selectArrow, 'none');
      assert.deepEqual(styles.choiceDisplays, ['flex', 'flex', 'flex']);
      assert.equal(styles.sectionBorder, 'solid');
      assert.equal(styles.fieldBorder, 'solid');
      assert.equal(styles.overflow, false);
      await page.locator('#title').focus();
      assert.notEqual(await page.locator('#title').evaluate(el => getComputedStyle(el).boxShadow), 'none');
      await page.locator('#title').evaluate(el => { el.setAttribute('aria-invalid', 'true'); });
      await page.waitForFunction(expected => getComputedStyle(document.querySelector('#title')).borderTopColor === expected,
        theme === 'dark' ? 'rgb(248, 113, 113)' : 'rgb(220, 38, 38)');
      await page.locator('#title').evaluate(el => { el.disabled = true; });
      assert.equal(await page.locator('#title').evaluate(el => getComputedStyle(el).cursor), 'not-allowed');
      console.log(`PASS shared form CSS: ${width}px ${theme}`);
      await page.close();
    }
  }
} finally {
  await browser.close();
}
