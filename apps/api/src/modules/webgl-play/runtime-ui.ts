import { accelerationMarkup, accelerationStyle } from './runtime-acceleration-presentation.js';
import { createHash } from 'node:crypto';

interface ShellConfig {
	API_PUBLIC_URL: string;
	WEB_PUBLIC_URL: string;
	PUBLIC_ASSET_ORIGIN?: string;
}

// The probe intentionally mirrors apps/web/src/lib/graphicsAcceleration.ts; executable
// shell tests cover the same renderer, strict-context, uncertainty and cleanup cases.
// Static code is hashed by the response CSP; no project-provided text is script or markup.
const script = String.raw`(() => {
'use strict';
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software rasterizer|microsoft basic render driver/i;

function probeContext(version, strict) {
	let context = null;
	try {
		// Context attributes are fixed on first creation, so every probe needs its own canvas.
		const canvas = document.createElement('canvas');
		canvas.width = 1;
		canvas.height = 1;
		context = canvas.getContext(version, { failIfMajorPerformanceCaveat: strict });
		if (!context) return { supported: false, failed: false, renderer: null };
		if (context.isContextLost()) return { supported: false, failed: true, renderer: null };

		// Renderer details may be withheld by privacy settings. That is inconclusive,
		// not evidence that hardware acceleration is disabled.
		let renderer = null;
		if (!strict) {
			const debugInfo = context.getExtension('WEBGL_debug_renderer_info');
			if (debugInfo) {
				const value = context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
				if (typeof value === 'string' && value.trim()) renderer = value;
			}
		}
		return { supported: true, failed: false, renderer };
	} catch {
		return { supported: context !== null, failed: true, renderer: null };
	} finally {
		// Release GPU resources even if reading the renderer or creating another probe fails.
		try {
			context?.getExtension('WEBGL_lose_context')?.loseContext();
		} catch {
			// Cleanup is best effort and must not turn a usable probe into an error.
		}
	}
}

/** A local hint about WebGL acceleration, not a browser-setting or GPU guarantee. */
function detectGraphicsAcceleration() {
	if (typeof document === 'undefined') return 'unknown';

	let failed = false;
	for (const version of ['webgl2', 'webgl']) {
		const normal = probeContext(version, false);
		failed ||= normal.failed;
		if (!normal.supported) continue;
		if (normal.renderer && SOFTWARE_RENDERER.test(normal.renderer)) return 'software';

		const strict = probeContext(version, true);
		if (strict.failed) return 'unknown';
		if (!strict.supported) return 'performance-caveat';
		return normal.renderer && !normal.failed ? 'available' : 'unknown';
	}
	return failed ? 'unknown' : 'unavailable';
}

const root = document.querySelector('main');
const status = document.getElementById('status');
const title = document.getElementById('title');
const frameHost = document.getElementById('game');
const restart = document.getElementById('restart');
const fullscreen = document.getElementById('fullscreen');
const displayInfo = document.getElementById('display-info');
let displaySize;
let session;
let checking = false;
let stopped = false;
let lastCheck = 0;
const announce = message => { status.textContent = message; };
function fitDisplay() {
  if (!displaySize) return;
  const frame = frameHost.firstElementChild;
  if (!frame) return;
  const inFullscreen = document.fullscreenElement === root;
  const scale = Math.max(0, Math.min(frameHost.clientWidth / displaySize.width,
    frameHost.clientHeight / displaySize.height, inFullscreen ? Infinity : 1));
  frame.style.width = displaySize.width + 'px';
  frame.style.height = displaySize.height + 'px';
  frame.style.transform = 'translate(-50%, -50%) scale(' + scale + ')';
  fullscreen.textContent = inFullscreen ? '전체화면 나가기' : '전체화면';
  fullscreen.setAttribute('aria-pressed', String(inFullscreen));
}
function configureDisplay(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || width > 8192 || height > 8192) return;
  displaySize = { width, height };
  root.classList.add('configured-display');
  displayInfo.hidden = false;
  displayInfo.textContent = '기준 표시 크기 ' + width + ' × ' + height
    + ' CSS 픽셀 · 표시 배율은 Unity 렌더링 해상도와 다릅니다.';
  fullscreen.hidden = typeof root.requestFullscreen !== 'function';
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fitDisplay).observe(frameHost);
  window.addEventListener('resize', fitDisplay);
  document.addEventListener('fullscreenchange', fitDisplay);
  fitDisplay();
}
fullscreen.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement === root) await document.exitFullscreen();
    else await root.requestFullscreen();
  } catch { announce('전체화면을 열지 못했습니다. 브라우저의 전체화면 권한을 확인해 주세요.'); }
});
function stop(message) {
  stopped = true;
  frameHost.replaceChildren();
  announce(message);
  restart.disabled = false;
}
async function post(path, body, control) {
  const response = await fetch('/api/webgl-play/sessions' + path, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(control ? { 'X-PCU-Play-Control': control } : {}) },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(response.status === 401 || response.status === 403
    ? '플레이 권한이 만료되었거나 변경되었습니다. 작품 화면에서 로그인과 접근 권한을 확인한 뒤 다시 시작해 주세요.'
    : '실행 서버에 연결하지 못했습니다. 연결 상태를 확인한 뒤 다시 시작해 주세요.');
  return result.data;
}
async function check() {
  if (!session || stopped || checking || document.visibilityState !== 'visible') return;
  checking = true;
  try {
    const result = await post('/' + session.id + '/renew', { visible: true }, session.controlSecret);
    session.expiresAt = result.expiresAt;
    lastCheck = Date.now();
  } catch (error) { stop(error.message); }
  finally { checking = false; }
}
restart.addEventListener('click', async () => {
  if (session && !stopped && !confirm('게임을 다시 시작할까요? 저장하지 않은 진행 상황은 사라질 수 있습니다.')) return;
  restart.disabled = true;
  frameHost.replaceChildren();
  if (session) await post('/' + session.id + '/close', {}, session.controlSecret).catch(() => {});
  location.reload();
});
// Never refresh hidden tabs; returning to a tab always rechecks authority.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void check(); });
setInterval(() => { if (Date.now() - lastCheck >= 60000) void check(); }, 1000);
window.addEventListener('pagehide', () => {
  if (session) void fetch('/api/webgl-play/sessions/' + session.id + '/close', {
    method: 'POST', credentials: 'same-origin', keepalive: true,
    headers: { 'Content-Type': 'application/json', 'X-PCU-Play-Control': session.controlSecret }, body: '{}',
  }).catch(() => {});
});
async function start() {
  try {
    if (!window.isSecureContext || typeof WebAssembly === 'undefined') {
      stop('이 실행 환경에서는 WebAssembly를 사용할 수 없습니다. HTTPS로 접속하고 데스크톱 Chrome, Edge 또는 Firefox를 확인해 주세요.');
      return;
    }
    session = await post('', { projectId: Number(root.dataset.projectId) });
    const target = new URL(session.iframeUrl);
    if (target.origin !== root.dataset.assetOrigin || !/^\/runtime\/[a-f0-9]{64}\//.test(target.pathname)
        || target.username || target.password || target.search || target.hash) throw new Error('올바르지 않은 게임 실행 주소입니다.');
    const directory = target.origin + target.pathname.split('/').slice(0, 3).join('/') + '/';
    const policy = document.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.content = 'frame-src ' + directory;
    document.head.append(policy);
    title.textContent = session.projectTitle;
    document.title = session.projectTitle + ' — WebGL Player';
    const frame = document.createElement('iframe');
    frame.setAttribute('credentialless', '');
    frame.setAttribute('sandbox', 'allow-scripts allow-pointer-lock allow-same-origin');
    frame.setAttribute('allow', 'fullscreen; autoplay; cross-origin-isolated ' + target.origin);
    frame.referrerPolicy = 'no-referrer';
    frame.title = session.projectTitle + ' WebGL 플레이어';
    frame.src = target.href;
    frameHost.replaceChildren(frame);
    configureDisplay(session.webglDisplayWidth, session.webglDisplayHeight);
    lastCheck = Date.now();
    restart.disabled = false;
    announce(window.crossOriginIsolated
      ? '게임 파일을 불러오고 있습니다. 처음 실행할 때는 시간이 걸릴 수 있습니다.'
      : '브라우저 격리가 활성화되지 않았습니다. 멀티스레드 빌드는 실행되지 않을 수 있습니다.');
  } catch (error) { stop(error.message); }
}
const gate = document.getElementById('acceleration-gate');
const retry = document.getElementById('acceleration-retry');
const proceed = document.getElementById('acceleration-continue');
const browser = document.getElementById('guide-browser');
const guide = document.getElementById('guide-steps');
const address = document.getElementById('guide-address');
let released = false;
function release() {
  if (released) return;
  released = true;
  retry.disabled = true;
  proceed.disabled = true;
  if (gate.open && typeof gate.close === 'function') gate.close();
  gate.removeAttribute('open');
  gate.hidden = true;
  void start();
}
const browserNames = { chrome: 'Chrome', edge: 'Edge', brave: 'Brave', firefox: 'Firefox', whale: 'Whale', opera: 'Opera', safari: 'Safari', other: '기타 브라우저', mobile: '모바일 브라우저' };
const help = {
  chrome: 'https://support.google.com/meet/answer/9302964?hl=ko',
  edge: 'https://learn.microsoft.com/en-us/troubleshoot/microsoft-edge/performance/edge-high-cpu-memory',
  brave: 'https://support.brave.app/hc/en-us/sections/360002510351-Settings-management',
  firefox: 'https://support.mozilla.org/ko/kb/performance-settings',
  whale: 'https://help.whale.naver.com/ko/desktop/', opera: 'https://help.opera.com/en/faq/', safari: 'https://support.apple.com/ko-kr/102564',
};
const chromiumExample = { file:'chromium-system.webp', width:1408, height:310, caption:'Chromium 설정 예시 · 브라우저와 버전에 따라 화면이 다를 수 있어요.', alt:'Chromium 시스템 설정의 그래픽 가속 사용 옵션' };
const screenshots = {
  chrome:chromiumExample, edge:chromiumExample, opera:chromiumExample, whale:chromiumExample,
  brave:{ file:'brave-system.webp', width:1408, height:422, caption:'Brave 설정 화면 · 그래픽 가속 옵션을 확인해 주세요.', alt:'Brave 시스템 설정의 그래픽 가속 사용 옵션' },
  firefox:{ file:'firefox-performance.png', width:600, height:147, caption:'Firefox 설정 화면 · 하드웨어 가속을 켠 상태예요.', alt:'Firefox 성능 설정에서 권장 성능 설정 사용은 해제되고 하드웨어 가속 사용은 선택된 화면' },
};
const figure = document.getElementById('guide-screenshot');
const preview = document.getElementById('guide-preview');
const enlarged = document.getElementById('guide-enlarged');
const image = document.getElementById('guide-image');
const enlargedImage = document.getElementById('guide-enlarged-image');
function showDialog(dialog) {
  dialog.hidden = false;
  try { if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', ''); }
  catch { dialog.setAttribute('open', ''); }
}
function closeEnlarged() {
  if (typeof enlarged.close === 'function') enlarged.close();
  else enlarged.removeAttribute('open');
  enlarged.hidden = true;
  preview.focus();
}
preview.addEventListener('click', () => { if (!figure.hidden) showDialog(enlarged); });
document.getElementById('guide-enlarged-close').addEventListener('click', closeEnlarged);
enlarged.addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); closeEnlarged(); });
image.addEventListener('error', () => { figure.hidden = true; });
let manualBrowser = false;
let detectedBrowser = 'other';
let mobile = false;
function updateGuide() {
  const selected = browser.value;
  const chromium = ['chrome', 'edge', 'brave', 'whale', 'opera'].includes(selected);
  const generic = ['mobile', 'safari', 'other'].includes(selected);
  document.getElementById('guide-name').textContent = (manualBrowser ? browserNames[selected] : browserNames[detectedBrowser]) + ' · ' + (selected === 'mobile' ? '모바일' : '컴퓨터');
  document.getElementById('guide-detection').textContent = manualBrowser ? '직접 선택' : detectedBrowser === 'other' ? '브라우저 확인 필요' : '자동 감지';
  address.textContent = chromium ? (selected === 'edge' ? 'edge://settings/systemAndPerformance' : selected === 'opera' ? 'opera://settings' : selected + '://settings/system') : '';
  document.getElementById('guide-address-row').hidden = !chromium;
  const path = selected === 'edge' ? '메뉴 ⋯ → 설정 → 시스템 및 성능 → 시스템' : selected === 'whale' ? '메뉴 ⋮ → 설정 → 성능 및 기타 → 시스템' : selected === 'opera' ? 'Opera 메뉴 → 설정 → 브라우저 → 시스템' : '메뉴 → 설정 → 시스템';
  const steps = selected === 'firefox'
    ? ['메뉴 ☰ → 설정 → 탭 및 탐색 → 성능 (이전 버전은 일반 → 성능)', '‘권장 성능 설정 사용’을 해제하고 하드웨어 가속을 켜세요.', '작업을 저장한 뒤 브라우저를 다시 시작하세요.']
    : generic ? ['브라우저와 운영체제를 최신 버전으로 업데이트하세요.', '브라우저를 다시 시작하고 이 게임 페이지로 돌아오세요.', '계속 실행되지 않으면 다른 최신 브라우저나 컴퓨터를 이용하세요.']
    : [path, '‘가능한 경우 그래픽 가속 사용’을 켜세요. ‘하드웨어 가속’으로 표시될 수도 있어요.', '작업을 저장한 뒤 브라우저를 다시 시작하세요.'];
  guide.replaceChildren(...steps.map(text => { const item = document.createElement('li'); item.textContent = text; return item; }));
  document.getElementById('guide-note').textContent = generic ? '이 환경에서는 그래픽 가속 설정을 직접 바꾸지 못할 수 있어요.' : '설정을 바꾼 뒤 이 페이지로 돌아와 다시 확인해 주세요.';
  const link = document.getElementById('guide-help');
  link.hidden = !help[selected];
  if (help[selected]) link.href = help[selected];
  const screenshot = screenshots[selected];
  figure.hidden = !screenshot;
  if (screenshot) {
    for (const target of [image, enlargedImage]) {
      target.alt = screenshot.alt; target.width = screenshot.width; target.height = screenshot.height;
      target.src = root.dataset.graphicsAssets + screenshot.file;
    }
    document.getElementById('guide-caption').textContent = screenshot.caption;
    document.getElementById('guide-enlarged-caption').textContent = screenshot.caption;
  }
}
browser.addEventListener('change', () => { manualBrowser = true; updateGuide(); });
// Local low-entropy hints match the original frontend; failure never blocks the gate.
try {
  const ua = navigator.userAgent || '';
  const brands = navigator.userAgentData?.brands?.map(item => item.brand).join(' ') || '';
  mobile = navigator.userAgentData?.mobile === true || /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  detectedBrowser = /Microsoft Edge/i.test(brands) || /Edg(?:A|iOS)?\//i.test(ua) ? 'edge'
    : /Brave/i.test(brands) || /Brave\//i.test(ua) ? 'brave'
    : /Whale/i.test(brands) || /Whale\//i.test(ua) ? 'whale'
    : /Opera/i.test(brands) || /(?:OPR|Opera|OPT)\//i.test(ua) ? 'opera'
    : /Firefox/i.test(brands) || /(?:Firefox|FxiOS)\//i.test(ua) ? 'firefox'
    : /Google Chrome/i.test(brands) || /(?:Chrome|CriOS)\//i.test(ua) ? 'chrome'
    : /Version\/[^ ]+.*Safari\//i.test(ua) ? 'safari' : 'other';
} catch { /* Browser detection is optional. */ }
browser.value = mobile ? 'mobile' : detectedBrowser;
updateGuide();
try {
  if (typeof navigator.brave?.isBrave === 'function') {
    Promise.resolve(navigator.brave.isBrave()).then(isBrave => {
      if (isBrave && !manualBrowser) { detectedBrowser = 'brave'; browser.value = mobile ? 'mobile' : detectedBrowser; updateGuide(); }
    }).catch(() => {});
  }
} catch { /* Browser detection is optional. */ }
function inspectAcceleration() {
  if (released) return;
  const result = detectGraphicsAcceleration();
  if (result === 'available' || result === 'unknown') { release(); return; }
  announce('게임을 시작하기 전에 그래픽 가속 설정을 확인해 주세요.');
  gate.hidden = false;
  if (!gate.open) {
    try {
      if (typeof gate.showModal === 'function') gate.showModal();
      else gate.setAttribute('open', '');
    } catch { gate.setAttribute('open', ''); }
  }
}
retry.addEventListener('click', () => {
  inspectAcceleration();
  if (!released) document.getElementById('acceleration-result').textContent = '아직 그래픽 가속을 확인하지 못했어요. 브라우저를 다시 시작한 후 확인해 주세요.';
});
proceed.addEventListener('click', release);
document.getElementById('acceleration-close').addEventListener('click', () => location.assign(document.getElementById('back').href));
gate.addEventListener('cancel', event => {
  event.preventDefault();
  location.assign(document.getElementById('back').href);
});
if (!window.isSecureContext || typeof WebAssembly === 'undefined') void start();
else inspectAcceleration();
})();`;

const shellStyle = `:root{background:#101318;color:#edf1f6}body{margin:0}main{min-height:100vh;display:flex;flex-direction:column}main>header{display:flex;align-items:center;gap:1rem;flex-wrap:wrap;padding:1rem 1.5rem}h1{font-size:1.25rem;margin:0;flex:1}main>header a,main>header button{color:inherit;background:#273342;border:1px solid #58697c;border-radius:.4rem;padding:.6rem .8rem;font:inherit}button:disabled{opacity:.5}#status,main>details{margin:.5rem 1.5rem;line-height:1.6}#game{flex:1;min-height:65vh;display:flex}iframe{border:0;width:100%;min-height:65vh;flex:1}main>details{padding-bottom:1rem}.configured-display{height:100dvh;min-height:0;overflow:hidden}.configured-display>header,.configured-display>p,.configured-display>details{flex-shrink:0}.configured-display>details{max-height:30dvh;overflow:auto}.configured-display #game{position:relative;min-height:0;min-width:0;overflow:hidden}.configured-display iframe{position:absolute;left:50%;top:50%;min-height:0;flex:none;transform-origin:center}.configured-display:fullscreen{width:100vw;height:100dvh;background:#101318}[hidden]{display:none!important}#display-info{font-size:.85rem;color:#c3cedc;margin:.25rem 1.5rem}`;
const graphicsAssets = (config: ShellConfig) => new URL('/help/graphics-acceleration/', config.WEB_PUBLIC_URL).href;
const shellStyles = (config: ShellConfig) => shellStyle + accelerationStyle + `@font-face{font-family:'Pretendard Variable';font-style:normal;font-weight:45 920;font-display:swap;src:url(${JSON.stringify(graphicsAssets(config) + 'PretendardVariable.woff2')}) format('woff2');}`;

const hash = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

export function playShellHeaders(config: ShellConfig): Record<string, string> {
	const assetOrigin = new URL(config.PUBLIC_ASSET_ORIGIN ?? config.API_PUBLIC_URL).origin;
	return {
		'Cache-Control': 'private, no-store',
		'Cross-Origin-Opener-Policy': 'same-origin',
		'Cross-Origin-Embedder-Policy': 'require-corp',
		'Cross-Origin-Resource-Policy': 'same-origin',
		'Permissions-Policy': `cross-origin-isolated=(self "${assetOrigin}"), fullscreen=(self "${assetOrigin}"), autoplay=(self "${assetOrigin}"), camera=(), microphone=(), geolocation=()`,
		'Content-Security-Policy': `default-src 'none'; script-src ${hash(script)}; style-src ${hash(shellStyles(config))}; connect-src 'self'; img-src ${graphicsAssets(config)}; font-src ${graphicsAssets(config)}PretendardVariable.woff2; frame-src ${assetOrigin}/runtime/; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
		'Referrer-Policy': 'no-referrer',
		'X-Content-Type-Options': 'nosniff',
	};
}

export function renderPlayShell(config: ShellConfig, projectId: number): string {
	if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new Error('Invalid project ID');
	const back = new URL(`/projects/${projectId}`, config.WEB_PUBLIC_URL).href;
	const assetOrigin = new URL(config.PUBLIC_ASSET_ORIGIN ?? config.API_PUBLIC_URL).origin;
	return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WebGL Player</title><style>${shellStyles(config)}</style></head><body><main data-graphics-assets="${escapeHtml(graphicsAssets(config))}" data-project-id="${projectId}" data-asset-origin="${escapeHtml(assetOrigin)}"><header><h1 id="title">WebGL Player</h1><a id="back" href="${escapeHtml(back)}" rel="noopener">작품으로 돌아가기</a><button id="fullscreen" type="button" aria-pressed="false" hidden>전체화면</button><button id="restart" type="button" disabled>게임 다시 시작</button></header><p id="status" role="status">실행 권한을 확인하고 있습니다.</p><p id="display-info" hidden></p><div id="game"></div>${accelerationMarkup}<details><summary>게임이 실행되지 않나요?</summary><p>데스크톱 Chrome·Edge·Firefox에서 실행해 주세요. 브라우저를 업데이트하고 그래픽 가속을 확인해 주세요. Safari와 모바일은 지원 보장 대상이 아닙니다.</p><p>다른 탭으로 이동한 상태에서 권한이 만료되면 돌아왔을 때 다시 시작해야 합니다. 게임별 저장소 분리와 방문 간 저장 데이터 유지는 보장하지 않습니다. Firefox는 credentialless 지원과 저장소 동작이 다를 수 있으며 실제 게임과 Worker의 격리 결과에 따라 스레드 지원이 결정됩니다.</p><p>외부 연결 실패 시 개발자 도구에서 CSP 차단과 외부 서버 CORS 오류를 구분할 수 있습니다. 승인된 외부 서버도 실제 NAS 게임 origin에 대한 CORS 설정이 필요합니다. 작품명, 브라우저 버전과 오류 내용을 운영자에게 전달해 주세요.</p></details></main><script>${script}</script></body></html>`;
}
