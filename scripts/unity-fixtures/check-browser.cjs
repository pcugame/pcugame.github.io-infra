const fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const fixtureRoot = path.resolve(process.env.FIXTURE_ROOT || '/tmp/pcu-unity-fixture-repro');
const baseUrl = process.env.FIXTURE_BASE_URL || 'http://127.0.0.1:19011';
if (!['127.0.0.1', 'localhost'].includes(new URL(baseUrl).hostname))
    throw Error('Fixture tests require loopback origins');
const env = { ...process.env, ...(process.env.BROWSER_ENV_FILE ? JSON.parse(fs.readFileSync(process.env.BROWSER_ENV_FILE)) : {}) };
const browsers = [['chrome', process.env.CHROME_EXECUTABLE || '/tmp/pcu-unity-fixtures/browsers/chrome/opt/google/chrome/chrome'], ['edge', process.env.EDGE_EXECUTABLE || '/tmp/pcu-unity-fixtures/browsers/edge/opt/microsoft/msedge/msedge']];
const configs = process.env.FIXTURE_CONFIGS ? process.env.FIXTURE_CONFIGS.split(',') : fs.readdirSync(path.join(fixtureRoot, 'published'));
(async () => {
    fs.mkdirSync(path.join(fixtureRoot, 'results'), { recursive: true });
    for (const [name, executablePath] of browsers) {
        const results = [];
        let browser;
        try {
            browser = await chromium.launch({ executablePath, env, headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
            console.log(name, 'version', browser.version());
            for (const fixture of configs) {
                const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
                const errors = [], responses = [], failures = [];
                page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning')
                    errors.push(m.text()); });
                page.on('pageerror', e => errors.push(e.message));
                page.on('requestfailed', r => failures.push({ url: r.url(), reason: r.failure()?.errorText }));
                page.on('response', r => { if (r.url().includes('/Build/'))
                    responses.push({ url: r.url(), status: r.status(), headers: r.headers() }); });
                page.on('dialog', d => { errors.push(d.message()); d.dismiss(); });
                let status = 'loaded';
                let target = page;
                try {
                    if (process.env.TRUSTED_SHELL === 'true') {
                        const list = await (await fetch(process.env.FIXTURE_API_URL ? process.env.FIXTURE_API_URL + '/fixture-list' : 'http://127.0.0.1:19012/fixture-list')).json();
                        const entry = list.find(x => x.name === fixture);
                        if (!entry)
                            throw Error('fixture not found');
                        await page.context().addCookies([{ name: 'fixture_cookie', value: 'present', url: baseUrl }]);
                        await page.goto(entry.shellUrl, { waitUntil: 'domcontentloaded' });
                        await page.locator('#game iframe').waitFor();
                        target = await (await page.locator('#game iframe').elementHandle()).contentFrame();
                    }
                    else
                        await page.goto(baseUrl + '/' + fixture + '/index.html', { waitUntil: 'domcontentloaded' });
                    await target.waitForFunction(() => window.__fixture?.ready || window.__fixture?.blocked, null, { timeout: 60000 });
                    if (await target.evaluate(() => window.__fixture.blocked))
                        throw Error('CSP blocked Unity loader');
                    await page.waitForTimeout(2500);
                    if (fixture.startsWith('threaded-gltf')) {
                        await target.evaluate(() => { window.__fixture.externalBlocked = false; addEventListener('securitypolicyviolation', e => { if (e.blockedURI.startsWith('https://raw.githubusercontent.com/'))
                            __fixture.externalBlocked = true; }); window.viewer.onModelLoaded = success => __fixture.modelLoaded = Boolean(success); window.viewer.updateStopWatch = () => { }; window.viewer.loadGltf('https://raw.githubusercontent.com/KhronosGroupArchives/glTF-Sample-Models/d7a3cc8e51d7c573771ae77a57f16b0662a905c6/2.0/Box/glTF-Binary/Box.glb'); });
                        await target.waitForFunction(() => __fixture.externalBlocked, null, { timeout: 10000 });
                        await page.waitForTimeout(500);
                        await target.evaluate(() => { __fixture.modelLoaded = null; viewer.loadGltf(new URL('StreamingAssets/Box.glb', location.href).href); });
                        await target.waitForFunction(() => __fixture.modelLoaded === true, null, { timeout: 20000 });
                        await page.waitForTimeout(1500);
                    }
                    await target.locator('canvas').first().click({ position: fixture.startsWith('native-gzip') ? { x: 480, y: 480 } : { x: 100, y: 100 } });
                    await page.keyboard.press('ArrowRight');
                    await page.waitForTimeout(500);
                    await page.screenshot({ path: path.join(fixtureRoot, 'results') + '/' + name + '-' + fixture + '.png' });
                }
                catch (e) {
                    status = 'failed';
                    errors.push(String(e));
                    await page.screenshot({ path: path.join(fixtureRoot, 'results') + '/' + name + '-' + fixture + '-failed.png' }).catch(() => { });
                }
                const parentState = await page.evaluate(() => ({ isolated: crossOriginIsolated, sab: typeof SharedArrayBuffer === 'function', iframe: document.querySelector('iframe')?.outerHTML }));
                const state = await target.evaluate(() => ({ fixture: window.__fixture, isolated: crossOriginIsolated, userAgent: navigator.userAgent, canvas: [...document.querySelectorAll('canvas')].map(c => ({ width: c.width, height: c.height, clientWidth: c.clientWidth, clientHeight: c.clientHeight })) })).catch(e => ({ error: String(e) }));
                if (!state.fixture?.ready || !state.canvas?.some(c => c.width > 0 && c.height > 0)) status = 'failed';
                if (fixture.startsWith('threaded-gltf') && (!state.isolated || !state.fixture?.sab || !state.fixture?.externalBlocked || !state.fixture?.modelLoaded || !state.fixture?.workers?.some(w => w.messages.includes('loaded')) || (process.env.TRUSTED_SHELL === 'true' && (!parentState.isolated || !parentState.sab || !state.fixture.parentBlocked)))) status = 'failed';
                if (status === 'failed') process.exitCode = 1;
                results.push({ browser: name, version: browser.version(), fixture, status, state, parentState, errors, responses, failures });
                fs.writeFileSync(path.join(fixtureRoot, 'results') + '/' + name + (process.env.RESULT_SUFFIX || '') + '.json', JSON.stringify(results, null, 2));
                console.log(name, fixture, status, 'ready', state.fixture?.ready, 'workers', state.fixture?.workers?.length, 'errors', errors.length);
                await page.close();
            }
        }
        catch (e) {
            console.log(name, 'LAUNCH FAILED', String(e));
            process.exitCode = 1;
        }
        finally {
            await browser?.close();
        }
    }
})();
