// Local Vite mock server only. No API, production writes, or production probe route.
// PLAYWRIGHT_MODULE_PATH=/path/to/playwright/index.mjs UI_BASE_URL=http://127.0.0.1:5178 node scripts/check-ui-styles.mjs
// Optional regex: UI_ROUTE_FILTER="network|votes|change-requests/" (baselines always run).
// Optional: UI_ARTIFACT_DIR=/tmp/pcu-ui-styles PLAYWRIGHT_BROWSER=firefox BROWSER_EXECUTABLE=/path/to/browser
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const playwright = process.env.PLAYWRIGHT_MODULE_PATH
  ? await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href) : require('playwright');
const base = process.env.UI_BASE_URL || 'http://127.0.0.1:5178';
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname), 'Use a local mock server');
const artifactDir = process.env.UI_ARTIFACT_DIR;
if (artifactDir) await mkdir(artifactDir, { recursive: true });
const browser = await playwright[process.env.PLAYWRIGHT_BROWSER || 'chromium'].launch({
  headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
});
const report = [];
try {
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await context.newPage();
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.evaluate(theme => {
      document.documentElement.dataset.theme = theme;
      document.body.innerHTML = `<main class="ui-panel ui-stack" id="probe">
        <h1>Native controls / 공통 기본 스타일</h1>
        <label>Text<input id="text" placeholder="Placeholder"></label>
        <label>Telephone<input id="tel" type="tel"></label>
        <label>Time<input id="time" type="time"></label>
        <label>Notes<textarea id="notes"></textarea></label>
        <label>Select<select id="select"><option>First</option><option>Second</option></select></label>
        <select id="multiple" multiple><option>First</option></select>
        <label>File<input id="file" type="file"></label>
        <label><input id="check" type="checkbox">Checkbox</label>
        <label><input id="radio" type="radio">Radio</label>
        <input id="range" type="range"><input id="color" type="color"><input id="hidden" type="hidden">
        <input id="invalid" aria-invalid="true"><fieldset disabled><input id="disabled"><button id="disabled-button">Disabled</button></fieldset>
        <button id="button">Neutral</button><button class="btn btn--primary" id="primary">Primary</button>
        <div data-ui="unstyled"><input id="unstyled-input"><button id="unstyled-button">Custom</button></div>
        <div class="ui-prose"><h2>Content</h2><p>Paragraph</p><ul><li>One</li><li>Two</li></ul><details><summary>Details</summary><p>Body</p></details></div>
      </main>`;
    }, theme);
    const computed = await page.evaluate(() => {
      const style = id => getComputedStyle(document.getElementById(id));
      const result = {};
      for (const id of ['text', 'tel', 'time', 'notes', 'select', 'file', 'check', 'radio', 'range', 'color', 'hidden', 'invalid', 'disabled', 'disabled-button', 'button', 'primary', 'unstyled-input', 'unstyled-button']) {
        const s = style(id);
        result[id] = { padding: parseFloat(s.paddingLeft), border: s.borderRadius, background: s.backgroundColor,
          borderColor: s.borderTopColor, opacity: s.opacity, display: s.display, resize: s.resize, fontSize: s.fontSize };
      }
      result.overflow = document.documentElement.scrollWidth > innerWidth;
      result.danger = getComputedStyle(document.documentElement).getPropertyValue('--color-danger').trim();
      return result;
    });
    for (const id of ['text', 'tel', 'time', 'notes', 'select', 'file', 'button']) {
      assert(computed[id].padding > 0, `${id} must receive baseline padding`);
      assert.notEqual(computed[id].border, '0px', `${id} must receive a rounded border`);
    }
    assert.equal(computed.notes.resize, 'vertical');
    for (const id of ['check', 'radio', 'range', 'unstyled-input', 'unstyled-button']) assert.equal(computed[id].padding, 0, `${id} excluded from text/button baseline`);
    assert.equal(computed.hidden.display, 'none');
    assert.equal(computed.disabled.opacity, '0.6');
    assert.equal(computed['disabled-button'].opacity, '0.5');
    assert.notEqual(computed.invalid.borderColor, computed.text.borderColor);
    assert.notEqual(computed.primary.background, computed.button.background, 'Explicit primary variant must override baseline');
    assert.equal(computed.overflow, false, 'Baseline fixture must fit mobile');
    await page.locator('#text').focus();
    assert(await page.locator('#text').evaluate(el => getComputedStyle(el).outlineStyle !== 'none'), 'Keyboard focus is visible');
    await page.locator('#select').selectOption({ label: 'Second' });
    assert.equal(await page.locator('#select').inputValue(), 'Second');
    await page.emulateMedia({ forcedColors: 'active' });
    assert.equal(await page.locator('#select').evaluate(el => getComputedStyle(el).appearance), 'auto');
    await page.emulateMedia({ forcedColors: 'none' });
    if (artifactDir) await page.screenshot({ path: `${artifactDir}/baseline-${width}-${theme}.png`, fullPage: true });
    report.push({ type: 'baseline', width, theme, passed: true });
    await context.close();
  }
  // All registered route families, including separate guide/play entrypoints.
  const routes = [
    ['anonymous', '/'], ['anonymous', '/years'], ['anonymous', '/years/2025'], ['anonymous', '/exhibitions/1'],
    ['anonymous', '/years/2025/mock-project-1'], ['anonymous', '/projects/1'], ['anonymous', '/projects/3'], ['anonymous', '/login'],
    ['owner', '/me'], ['owner', '/me/projects'], ['owner', '/me/projects/new'], ['owner', '/me/projects/new/studio'],
    ['owner', '/me/projects/1/change-request'], ['owner', '/me/projects/1/network'],
    ['ADMIN', '/admin'], ['ADMIN', '/admin/projects'], ['ADMIN', '/admin/projects/new'], ['ADMIN', '/admin/projects/new/studio'],
    ['ADMIN', '/admin/projects/1/edit'], ['ADMIN', '/admin/change-requests'], ['ADMIN', '/admin/years'],
    ['ADMIN', '/admin/settings'], ['ADMIN', '/admin/banned-ips'], ['ADMIN', '/admin/import'],
    ['ADMIN', '/admin/webgl-network'], ['ADMIN', '/admin/votes'],
    ['anonymous', '/projects/1/play'], ['anonymous', '/unity-webgl-guide/'],
  ];
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(base, { waitUntil: 'networkidle' });
  const fixtures = await page.evaluate(async () => {
    const mock = await import('/src/lib/api/mock/transport.ts');
    await mock.resetMockState();
    await (await import('/src/lib/api/mock/scenarios.ts')).chooseMockScenario('review');
    const state = await mock.getMockSnapshot();
    const request = Object.values(state.changeRequests)[0];
    const project = Object.values(state.projects).find(p => p.status === 'PUBLISHED' && p.visibility === 'PUBLIC');
    return { requestId: request.id, projectYear: project.year, projectSlug: project.slug };
  });
  routes[4][1] = `/years/${fixtures.projectYear}/${fixtures.projectSlug}`;
  routes.push(['owner', `/me/change-requests/${fixtures.requestId}`], ['ADMIN', `/admin/change-requests/${fixtures.requestId}`]);
  // Populate the real request/review controls through the local Mock API.
  await page.evaluate(async () => {
    const mock = await import('/src/lib/api/mock/transport.ts');
    await mock.selectMockUser('owner');
    const state = await mock.getMockSnapshot();
    const exhibitionId = state.projects[1].exhibitionId;
    const previous = state.exhibitions.find(e => e.id === exhibitionId).isModificationEnabled;
    await mock.updateMockState(state => { state.exhibitions.find(e => e.id === exhibitionId).isModificationEnabled = true; });
    try {
      await (await import('/src/lib/api/client.ts')).api.post('/api/me/projects/1/webgl-network-requests', {
        origin: 'https://review.example.com:*', mode: 'HTTPS', purpose: 'Style audit review fixture', cors: 'Allow the game origin',
      });
    } finally {
      await mock.updateMockState(state => { state.exhibitions.find(e => e.id === exhibitionId).isModificationEnabled = previous; });
    }
  });
  // Voting uses its own mock fixture store; get the public URL through the actual client.
  const voteId = await page.evaluate(async () => {
    await (await import('/src/lib/api/mock/transport.ts')).selectMockUser('ADMIN');
    const votes = await (await import('/src/features/voting/api.ts')).votingApi.list();
    return votes[0].id;
  });
  for (const suffix of ['', '/records', '/draw']) routes.push(['anonymous', `/votes/${voteId}${suffix}`]);
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [role, route] of routes.filter(([, route]) => !process.env.UI_ROUTE_FILTER || new RegExp(process.env.UI_ROUTE_FILTER).test(route))) {
      await page.goto(base, { waitUntil: 'networkidle' });
      await page.evaluate(async ({ role, theme }) => {
        await (await import('/src/lib/api/mock/transport.ts')).selectMockUser(role);
        localStorage.setItem('theme', theme);
      }, { role, theme });
      await page.goto(`${base}${route}`, { waitUntil: 'networkidle' });
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      const result = await page.evaluate(() => {
        const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
        const controls = [...document.querySelectorAll('input,textarea,select,button')].filter(visible);
        const suspect = controls.filter(el => {
          if (el.closest('.mock-switcher,[data-ui="unstyled"]')) return false;
          if (el.tagName === 'INPUT' && ['checkbox', 'radio', 'range', 'color', 'file', 'hidden'].includes(el.type)) return false;
          return el.tagName !== 'BUTTON' && parseFloat(getComputedStyle(el).paddingLeft) === 0;
        }).map(el => ({ tag: el.tagName, id: el.id, className: el.className }));
        return { title: document.querySelector('h1,h2')?.textContent, controls: controls.length,
          overflow: document.documentElement.scrollWidth > innerWidth + 1, suspect,
          alerts: [...document.querySelectorAll('[role="alert"]')].filter(visible).map(el => el.textContent),
        };
      });
      if (artifactDir) await page.screenshot({ path: `${artifactDir}/${route.replace(/\W+/g, '_')}-${width}-${theme}.png`, fullPage: true });
      report.push({ type: 'route', role, route, width, theme, ...result });
      if (route === '/me/projects/1/network') {
        const form = page.locator('#network-new-request');
        await form.getByLabel('포트 정책', { exact: true }).selectOption('specific');
        await form.getByLabel('특정 포트', { exact: true }).fill('8443');
        await form.getByLabel('도메인 (호스트명)', { exact: true }).fill('https://invalid.example.com/path');
        await form.locator('.field-error').first().waitFor();
        await form.getByLabel('도메인 (호스트명)', { exact: true }).fill('a'.repeat(60) + '.example.com');
        await form.getByLabel('호스트 범위', { exact: true }).selectOption('subdomains');
        const profiles = page.getByRole('region', { name: '서비스별 신청 예시' });
        const profileSelect = profiles.getByLabel('서비스', { exact: true });
        const values = await profileSelect.locator('option').evaluateAll(options => options.map(o => o.value));
        for (const value of values) {
          await profileSelect.selectOption(value);
          assert(await profiles.locator('input[type="checkbox"]').count() > 0);
          assert.equal(await profiles.getByLabel('예시 사용 목적', { exact: true }).evaluate(el => parseFloat(getComputedStyle(el).paddingLeft) > 0), true);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `Profile ${value} overflows`);
        }
        if (artifactDir) await page.screenshot({ path: `${artifactDir}/network-dynamic-${width}-${theme}.png`, fullPage: true });
        report.push({ type: 'dynamic-network', width, theme, profiles: values.length, passed: true });
      }
      if (route === `/votes/${voteId}`) {
        await page.locator('.vote-poster').first().click();
        await page.getByRole('button', { name: '투표 완료', exact: true }).click();
        await page.getByRole('dialog').waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Vote confirmation overflows');
        if (artifactDir) await page.screenshot({ path: `${artifactDir}/vote-confirm-${width}-${theme}.png`, fullPage: true });
        report.push({ type: 'dynamic-vote-confirm', width, theme, passed: true });
      }
      if (route === `/votes/${voteId}/records`) {
        await page.evaluate(async () => {
          const mock = await import('/src/lib/api/mock/transport.ts');
          await mock.updateMockState(state => { state.voting.votes[0].settings.state = 'CLOSED'; });
        });
        await page.reload({ waitUntil: 'networkidle' });
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await page.getByText(/총 \d+표/).waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Closed records overflow');
        if (artifactDir) await page.screenshot({ path: `${artifactDir}/vote-records-closed-${width}-${theme}.png`, fullPage: true });
        report.push({ type: 'dynamic-vote-records', width, theme, passed: true });
        await page.evaluate(async () => {
          await (await import('/src/lib/api/mock/transport.ts')).updateMockState(state => { state.voting.votes[0].settings.state = 'OPEN'; });
        });
      }
      if (route === '/admin/votes') {
        await page.getByLabel('투표 선택', { exact: true }).selectOption(voteId);
        await page.locator('.vote-upload').waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Existing vote controls overflow');
        if (artifactDir) await page.screenshot({ path: `${artifactDir}/vote-existing-${width}-${theme}.png`, fullPage: true });
        report.push({ type: 'dynamic-vote', width, theme, passed: true });
      }

    }
  }
  await context.close();
  if (artifactDir) await writeFile(`${artifactDir}/report.json`, JSON.stringify(report, null, 2));
  const issues = report.filter(r => r.overflow || r.suspect?.length);
  console.log(JSON.stringify({ browser: browser.version(), cases: report.length, routeFilter: process.env.UI_ROUTE_FILTER || null, issues, boundary: 'Local Mock and DOM/computed-style checks; screenshots require visual review' }, null, 2));
  assert.equal(issues.length, 0, 'Review overflow/style findings in the route report');
} finally { await browser.close(); }
