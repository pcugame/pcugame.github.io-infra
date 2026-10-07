import { SelectControl } from '../ui';
import { useEffect, useId, useState } from 'react';
import { detectBrowser, detectBrowserWithBrave, type BrowserName } from '../../lib/browserDetection';
import { GraphicsSettingsScreenshot } from './GraphicsSettingsScreenshot';

type GuideBrowser = BrowserName | 'mobile';

const browserNames: Record<GuideBrowser, string> = {
	chrome: 'Chrome', edge: 'Edge', brave: 'Brave', firefox: 'Firefox',
	whale: 'Whale', opera: 'Opera', safari: 'Safari', other: '기타 브라우저', mobile: '모바일 브라우저',
};

const help: Partial<Record<GuideBrowser, string>> = {
	chrome: 'https://support.google.com/meet/answer/9302964?hl=ko',
	edge: 'https://learn.microsoft.com/en-us/troubleshoot/microsoft-edge/performance/edge-high-cpu-memory',
	brave: 'https://support.brave.app/hc/en-us/sections/360002510351-Settings-management',
	firefox: 'https://support.mozilla.org/ko/kb/performance-settings',
	whale: 'https://help.whale.naver.com/ko/desktop/',
	opera: 'https://help.opera.com/en/faq/',
	safari: 'https://support.apple.com/ko-kr/102564',
};

function steps(browser: GuideBrowser): string[] {
	if (browser === 'firefox') return [
		'메뉴 ☰ → 설정 → 탭 및 탐색 → 성능 (이전 버전은 일반 → 성능)',
		'‘권장 성능 설정 사용’을 해제하고 하드웨어 가속을 켜세요.',
		'작업을 저장한 뒤 브라우저를 다시 시작하세요.',
	];
	if (browser === 'mobile' || browser === 'safari' || browser === 'other') return [
		'브라우저와 운영체제를 최신 버전으로 업데이트하세요.',
		'브라우저를 다시 시작하고 이 게임 페이지로 돌아오세요.',
		'계속 실행되지 않으면 다른 최신 브라우저나 컴퓨터를 이용하세요.',
	];
	const path = browser === 'edge' ? '메뉴 ⋯ → 설정 → 시스템 및 성능 → 시스템'
		: browser === 'whale' ? '메뉴 ⋮ → 설정 → 성능 및 기타 → 시스템'
		: browser === 'opera' ? 'Opera 메뉴 → 설정 → 브라우저 → 시스템'
		: '메뉴 → 설정 → 시스템';
	return [
		path,
		'‘가능한 경우 그래픽 가속 사용’을 켜세요. ‘하드웨어 가속’으로 표시될 수도 있어요.',
		'작업을 저장한 뒤 브라우저를 다시 시작하세요.',
	];
}

export function GraphicsAccelerationGuide() {
	const id = useId();
	const [detected, setDetected] = useState(detectBrowser);
	const [override, setOverride] = useState<GuideBrowser | null>(null);
	useEffect(() => {
		let active = true;
		void detectBrowserWithBrave().then((result) => { if (active) setDetected(result); });
		return () => { active = false; };
	}, []);
	const browser = override ?? (detected.mobile ? 'mobile' : detected.browser);
	const name = override ? browserNames[override] : browserNames[detected.browser];
	const device = browser === 'mobile' ? '모바일' : '컴퓨터';
	return (
		<div className="graphics-guide">
			<p className="graphics-guide__browser"><strong>{name} · {device}</strong><span>{override ? '직접 선택' : detected.browser === 'other' ? '브라우저 확인 필요' : '자동 감지'}</span></p>
			<ol className="graphics-guide__steps">{steps(browser).map((step) => <li key={step}>{step}</li>)}</ol>
			{['chrome', 'edge', 'brave', 'whale', 'opera'].includes(browser) && <p>주소창에 <code>{browser === 'edge' ? 'edge://settings/systemAndPerformance' : browser === 'opera' ? 'opera://settings' : `${browser}://settings/system`}</code>을 입력해 설정을 열 수 있어요.</p>}
			<GraphicsSettingsScreenshot browser={browser} />
			{browser === 'mobile' || browser === 'safari' || browser === 'other'
				? <p>이 환경에서는 그래픽 가속 설정을 직접 바꾸지 못할 수 있어요.</p>
				: <p>설정을 바꾼 뒤 이 페이지로 돌아와 다시 확인해 주세요.</p>}
			{help[browser] && <a className="graphics-guide__link" href={help[browser]}>설정 방법 보기</a>}
			<details className="graphics-guide__override">
				<summary>다른 브라우저 안내</summary>
				<label className="form-field__label" htmlFor={id}>사용 중인 브라우저</label>
				<SelectControl id={id} value={browser} onChange={(event) => setOverride(event.target.value as GuideBrowser)}>
					{Object.entries(browserNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
				</SelectControl>
			</details>
		</div>
	);
}
