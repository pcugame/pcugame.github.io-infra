import { createHash } from 'node:crypto';

interface ShellConfig {
	API_PUBLIC_URL: string;
	WEB_PUBLIC_URL: string;
	PUBLIC_ASSET_ORIGIN?: string;
}

// Static code is hashed by the response CSP; no project-provided text is script or markup.
const script = String.raw`(() => {
'use strict';
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
  const frame = frameHost.firstElementChild;
  if (!frame) return;
  const inFullscreen = document.fullscreenElement === root;
  fullscreen.textContent = inFullscreen ? '전체화면 나가기' : '전체화면';
  fullscreen.setAttribute('aria-pressed', String(inFullscreen));
  if (!displaySize) return;
  const scale = Math.max(0, Math.min(frameHost.clientWidth / displaySize.width,
    frameHost.clientHeight / displaySize.height, inFullscreen ? Infinity : 1));
  frame.style.width = displaySize.width + 'px';
  frame.style.height = displaySize.height + 'px';
  frame.style.transform = 'translate(-50%, -50%) scale(' + scale + ')';
}
function configureDisplay(kind, width, height) {
  if (kind === 'responsive') {
    root.classList.add('configured-display', 'responsive-display');
    displayInfo.hidden = false;
    displayInfo.textContent = '반응형 · 사용 가능한 화면 영역에 맞춤';
    fullscreen.hidden = typeof root.requestFullscreen !== 'function';
    document.addEventListener('fullscreenchange', fitDisplay);
    fitDisplay();
    return;
  }
  if (kind === 'legacy') return;
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
(async () => {
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
    configureDisplay(session.webglDisplayKind, session.webglDisplayWidth, session.webglDisplayHeight);
    lastCheck = Date.now();
    restart.disabled = false;
    announce(window.crossOriginIsolated
      ? '게임 파일을 불러오고 있습니다. 처음 실행할 때는 시간이 걸릴 수 있습니다.'
      : '브라우저 격리가 활성화되지 않았습니다. 멀티스레드 빌드는 실행되지 않을 수 있습니다.');
  } catch (error) { stop(error.message); }
})();
})();`;

const style = `:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#101318;color:#edf1f6}body{margin:0}main{min-height:100vh;display:flex;flex-direction:column}header{display:flex;align-items:center;gap:1rem;flex-wrap:wrap;padding:1rem 1.5rem}h1{font-size:1.25rem;margin:0;flex:1}a,button{color:inherit;background:#273342;border:1px solid #58697c;border-radius:.4rem;padding:.6rem .8rem;font:inherit}button:disabled{opacity:.5}#status,details{margin:.5rem 1.5rem;line-height:1.6}#game{flex:1;min-height:65vh;display:flex}iframe{border:0;width:100%;min-height:65vh;flex:1}details{padding-bottom:1rem}.configured-display{height:100dvh;min-height:0;overflow:hidden}.configured-display>header,.configured-display>p,.configured-display>details{flex-shrink:0}.configured-display>details{max-height:30dvh;overflow:auto}.configured-display #game{position:relative;min-height:0;min-width:0;overflow:hidden}.configured-display iframe{position:absolute;left:50%;top:50%;min-height:0;flex:none;transform-origin:center}.configured-display:fullscreen{width:100vw;height:100dvh;background:#101318}.responsive-display iframe{inset:0;width:100%;height:100%;transform:none}[hidden]{display:none!important}#display-info{font-size:.85rem;color:#c3cedc;margin:.25rem 1.5rem}`;
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
		'Content-Security-Policy': `default-src 'none'; script-src ${hash(script)}; style-src ${hash(style)}; connect-src 'self'; frame-src ${assetOrigin}/runtime/; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
		'Referrer-Policy': 'no-referrer',
		'X-Content-Type-Options': 'nosniff',
	};
}

export function renderPlayShell(config: ShellConfig, projectId: number): string {
	if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new Error('Invalid project ID');
	const back = new URL(`/projects/${projectId}`, config.WEB_PUBLIC_URL).href;
	const assetOrigin = new URL(config.PUBLIC_ASSET_ORIGIN ?? config.API_PUBLIC_URL).origin;
	return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WebGL Player</title><style>${style}</style></head><body><main data-project-id="${projectId}" data-asset-origin="${escapeHtml(assetOrigin)}"><header><h1 id="title">WebGL Player</h1><a href="${escapeHtml(back)}" rel="noopener">작품으로 돌아가기</a><button id="fullscreen" type="button" aria-pressed="false" hidden>전체화면</button><button id="restart" type="button" disabled>게임 다시 시작</button></header><p id="status" role="status">실행 권한을 확인하고 있습니다.</p><p id="display-info" hidden></p><div id="game"></div><details><summary>게임이 실행되지 않나요?</summary><p>데스크톱 Chrome·Edge·Firefox에서 실행해 주세요. 브라우저를 업데이트하고 그래픽 가속을 확인해 주세요. Safari와 모바일은 지원 보장 대상이 아닙니다.</p><p>다른 탭으로 이동한 상태에서 권한이 만료되면 돌아왔을 때 다시 시작해야 합니다. 게임별 저장소 분리와 방문 간 저장 데이터 유지는 보장하지 않습니다. Firefox는 credentialless 지원과 저장소 동작이 다를 수 있으며 실제 게임과 Worker의 격리 결과에 따라 스레드 지원이 결정됩니다.</p><p>외부 연결 실패 시 개발자 도구에서 CSP 차단과 외부 서버 CORS 오류를 구분할 수 있습니다. 승인된 외부 서버도 실제 NAS 게임 origin에 대한 CORS 설정이 필요합니다. 작품명, 브라우저 버전과 오류 내용을 운영자에게 전달해 주세요.</p></details></main><script>${script}</script></body></html>`;
}
