export type BrowserName = 'chrome' | 'edge' | 'brave' | 'firefox' | 'whale' | 'opera' | 'safari' | 'other';

export type BrowserDetection = { browser: BrowserName; mobile: boolean };

export type BrowserNavigator = Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'> & {
	userAgentData?: { brands?: readonly { brand: string }[]; mobile?: boolean };
	brave?: { isBrave?: () => Promise<boolean> };
};

function browserNavigator(): BrowserNavigator | undefined {
	return typeof navigator === 'undefined' ? undefined : navigator;
}

/** Use only local, low-entropy browser hints; unidentified Chromium forks remain unknown. */
export function detectBrowser(source: BrowserNavigator | undefined = browserNavigator()): BrowserDetection {
	if (!source) return { browser: 'other', mobile: false };
	try {
		const ua = source.userAgent;
		const brands = source.userAgentData?.brands?.map(({ brand }) => brand).join(' ') ?? '';
		const mobile = source.userAgentData?.mobile === true
			|| /Android|iPhone|iPad|iPod|Mobile/i.test(ua)
			|| (source.platform === 'MacIntel' && source.maxTouchPoints > 1);
		let browser: BrowserName = 'other';
		if (/Microsoft Edge/i.test(brands) || /Edg(?:A|iOS)?\//i.test(ua)) browser = 'edge';
		else if (/Brave/i.test(brands) || /Brave\//i.test(ua)) browser = 'brave';
		else if (/Whale/i.test(brands) || /Whale\//i.test(ua)) browser = 'whale';
		else if (/Opera/i.test(brands) || /(?:OPR|Opera|OPT)\//i.test(ua)) browser = 'opera';
		else if (/Firefox/i.test(brands) || /(?:Firefox|FxiOS)\//i.test(ua)) browser = 'firefox';
		else if (/Google Chrome/i.test(brands) || /(?:Chrome|CriOS)\//i.test(ua)) browser = 'chrome';
		else if (/Version\/[^ ]+.*Safari\//i.test(ua)) browser = 'safari';
		return { browser, mobile };
	} catch {
		return { browser: 'other', mobile: false };
	}
}

/** Brave can share Chrome's UA; a rejected or absent Brave API leaves the initial hint usable. */
export async function detectBrowserWithBrave(source: BrowserNavigator | undefined = browserNavigator()): Promise<BrowserDetection> {
	const initial = detectBrowser(source);
	try {
		if (typeof source?.brave?.isBrave === 'function' && await source.brave.isBrave()) {
			return { ...initial, browser: 'brave' };
		}
	} catch {
		// Detection is only a guide hint and must never prevent the visitor from continuing.
	}
	return initial;
}
