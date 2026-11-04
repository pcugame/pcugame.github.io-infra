/**
 * Shared form CSS browser checks. No API calls or production writes.
 * Start: npm exec --workspace apps/web vite -- --mode mock --host 127.0.0.1 --port 15185
 * Run: PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node apps/web/scripts/check-ui-styles.mjs
 * Optional UI_BASE_URL (default http://127.0.0.1:15185), CHROMIUM_PATH,
 * BROWSER_ENGINE (chromium/firefox/webkit), BROWSER_PATH.
 * Playwright is external verification tooling, not an application dependency.
 */
import assert from 'node:assert/strict';
const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const engine = process.env.BROWSER_ENGINE || 'chromium';

const base = process.env.UI_BASE_URL || 'http://127.0.0.1:15185';
const browser = await playwright[engine].launch({
  ...(process.env.BROWSER_PATH || process.env.CHROMIUM_PATH ? { executablePath: process.env.BROWSER_PATH || process.env.CHROMIUM_PATH } : {}),
  args: engine === 'chromium' ? ['--no-sandbox'] : [],
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
            <div class="form-field"><label class="form-choice"><input type="checkbox">Standalone choice</label></div>
            <div class="form-field"><label class="form-choice"><input type="checkbox">Wrapped choice</label></div>
            <input class="form-control" id="standalone" type="email" aria-label="Standalone field">
            <div class="form-actions"><button type="button" class="btn btn--primary">Save</button></div>
          </fieldset>
        ${['neutral', 'info', 'success', 'warning', 'danger'].map(tone => `<span class="status-badge status-badge--${tone}">${tone}</span>`).join('')}
        <p class="preserve-lines" id="multiline">Line one\nLine two</p><fieldset class="form-section form-section--plain" id="plain"><legend>Plain section</legend>
          <input class="form-control" value="Draft" aria-label="Plain input"></fieldset>
          <dialog class="dialog-frame dialog-frame--sm" aria-label="Upload" id="dialog">
            <header class="dialog-frame__header"><h2>Upload</h2></header>
            <div class="dialog-frame__body"><progress class="progress-bar progress-bar--sm" aria-label="Unknown"></progress>
            <progress class="progress-bar" value="0" max="100" aria-label="Zero"></progress></div>
            <footer class="dialog-frame__footer"><button>Close</button></footer>
          </dialog>
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
          selectAppearance: getComputedStyle(document.querySelector('#select')).appearance,
          choiceDisplays: [...document.querySelectorAll('.form-choice')].map(el => getComputedStyle(el).display),
          sectionBorder: sectionStyle.borderTopStyle,
          fieldBorder: titleStyle.borderTopStyle,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      assert.equal(styles.rootFont, width === 390 ? '16px' : '20px');
      assert.ok(styles.controlFonts.every(value => value === (width === 390 ? '16px' : '18px')), JSON.stringify(styles));
      assert.ok(styles.backgrounds.every(value => value === styles.backgrounds[0]), JSON.stringify(styles));
      if (styles.selectAppearance !== 'base-select') assert.notEqual(styles.selectArrow, 'none');
      assert.deepEqual(styles.choiceDisplays, ['flex', 'flex', 'flex']);
      assert.equal(styles.sectionBorder, 'solid');
      assert.equal(styles.fieldBorder, 'solid');
      assert.equal(styles.overflow, false);
      const badgeContrast = await page.locator('.status-badge').evaluateAll(badges => {
        const context = document.createElement('canvas').getContext('2d');
        const luminance = color => {
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
            const channel = value / 255;
            return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
          });
          return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
        };
        return badges.map(badge => {
          const style = getComputedStyle(badge);
          const [low, high] = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => a - b);
          return { tone: badge.textContent, ratio: (high + .05) / (low + .05) };
        });
      });
      assert.ok(badgeContrast.every(badge => badge.ratio >= 4.5), JSON.stringify(badgeContrast));
      await page.locator('#title').focus();
      assert.notEqual(await page.locator('#title').evaluate(el => getComputedStyle(el).boxShadow), 'none');
      await page.locator('#title').evaluate(el => { el.setAttribute('aria-invalid', 'true'); });
      await page.waitForFunction(expected => getComputedStyle(document.querySelector('#title')).borderTopColor === expected,
        theme === 'dark' ? 'rgb(248, 113, 113)' : 'rgb(220, 38, 38)');
      await page.locator('#title').evaluate(el => { el.disabled = true; });
      assert.equal(await page.locator('#title').evaluate(el => getComputedStyle(el).cursor), 'not-allowed');
      assert.equal(await page.locator('#multiline').evaluate(el => getComputedStyle(el).whiteSpace), 'pre-wrap');
      const plain = await page.locator('#plain').evaluate(el => {
        const style = getComputedStyle(el);
        return { border: style.borderWidth, padding: style.padding, background: style.backgroundColor, shadow: style.boxShadow };
      });
      assert.deepEqual(plain, { border: '0px', padding: '0px', background: 'rgba(0, 0, 0, 0)', shadow: 'none' });
      assert.equal(await page.locator('#dialog').isVisible(), false);
      await page.locator('#dialog').evaluate(el => el.showModal());
      const dialog = await page.locator('#dialog').evaluate(el => {
        const style = getComputedStyle(el);
        return { display: style.display, width: el.getBoundingClientRect().width, overflow: el.scrollWidth > el.clientWidth,
          headerPadding: getComputedStyle(el.querySelector('header')).padding,
          positions: [...el.querySelectorAll('progress')].map(bar => bar.position) };
      });
      assert.equal(dialog.display, 'flex');
      assert.ok(dialog.width < width);
      assert.equal(dialog.overflow, false);
      assert.equal(dialog.headerPadding, width === 390 ? '16px' : '25px');
      assert.deepEqual(dialog.positions, [-1, 0]);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#dialog').isVisible(), false);
      console.log(`PASS shared form/dialog/progress CSS: ${width}px ${theme}`);
      await page.close();
    }
  }
} finally {
  await browser.close();
}
