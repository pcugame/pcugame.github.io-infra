import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectBrowser, detectBrowserWithBrave, type BrowserNavigator } from '../lib/browserDetection';

const chrome = 'Mozilla/5.0 Chrome/150.0 Safari/537.36';
function source(userAgent: string, extra: Partial<BrowserNavigator> = {}): BrowserNavigator {
	return { userAgent, platform: 'Linux x86_64', maxTouchPoints: 0, ...extra };
}

afterEach(() => vi.unstubAllGlobals());

describe('local browser detection', () => {
	it.each([
		[chrome, 'chrome'],
		[`${chrome} Edg/150.0`, 'edge'],
		[`${chrome} Brave/150.0`, 'brave'],
		['Mozilla/5.0 Firefox/150.0', 'firefox'],
		[`${chrome} Whale/4.0`, 'whale'],
		[`${chrome} OPR/120.0`, 'opera'],
		['Mozilla/5.0 (Macintosh) Version/26.0 Safari/605.1.15', 'safari'],
		['UnknownBrowser/1.0', 'other'],
		['Mozilla/5.0 Chromium/150.0 Safari/537.36', 'other'],
	])('detects %s as %s without mistaking specific Chromium browsers for Chrome', (ua, browser) => {
		expect(detectBrowser(source(ua))).toEqual({ browser, mobile: false });
	});

	it.each([
		['Microsoft Edge', 'edge'], ['Brave', 'brave'], ['Whale', 'whale'],
		['Opera', 'opera'], ['Google Chrome', 'chrome'],
	])('uses the named UAData brand %s despite a generic Chrome UA', (brand, browser) => {
		expect(detectBrowser(source(chrome, {
			userAgentData: { brands: [{ brand: 'Not A;Brand' }, { brand: 'Chromium' }, { brand }], mobile: false },
		}))).toEqual({ browser, mobile: false });
	});

	it.each([
		['Mozilla/5.0 (Linux; Android 15) Chrome/150.0 Mobile Safari/537.36', 'chrome'],
		['Mozilla/5.0 (iPhone) CriOS/150.0 Mobile Safari/605.1.15', 'chrome'],
		['Mozilla/5.0 (iPhone) FxiOS/150.0 Mobile Safari/605.1.15', 'firefox'],
		['Mozilla/5.0 (iPhone) EdgiOS/150.0 Mobile Safari/605.1.15', 'edge'],
		['Mozilla/5.0 (iPad) Version/26.0 Mobile Safari/605.1.15', 'safari'],
	])('keeps browser identity but marks mobile settings unavailable for %s', (ua, browser) => {
		expect(detectBrowser(source(ua))).toEqual({ browser, mobile: true });
	});

	it('detects an iPad requesting a desktop Safari UA', () => {
		expect(detectBrowser(source('Mozilla/5.0 (Macintosh) Version/26.0 Safari/605.1.15', {
			platform: 'MacIntel', maxTouchPoints: 5,
		}))).toEqual({ browser: 'safari', mobile: true });
	});

	it('honors the mobile UAData hint', () => {
		expect(detectBrowser(source(chrome, { userAgentData: { mobile: true } })).mobile).toBe(true);
	});

	it('does not identify Brave from presence of a navigator.brave object alone', async () => {
		expect(await detectBrowserWithBrave(source(chrome, { brave: {} }))).toEqual({ browser: 'chrome', mobile: false });
	});

	it('uses the asynchronous Brave identity result and keeps the mobile hint', async () => {
		const isBrave = vi.fn().mockResolvedValue(true);
		expect(await detectBrowserWithBrave(source(chrome, { brave: { isBrave }, userAgentData: { mobile: true } })))
			.toEqual({ browser: 'brave', mobile: true });
		expect(isBrave).toHaveBeenCalledOnce();
	});

	it.each([false, 'reject', 'throw'])('preserves initial detection if Brave reports %s', async (result) => {
		const isBrave = result === 'throw' ? () => { throw new Error('blocked'); }
			: result === 'reject' ? () => Promise.reject(new Error('blocked')) : () => Promise.resolve(false);
		expect(await detectBrowserWithBrave(source(chrome, { brave: { isBrave } })))
			.toEqual({ browser: 'chrome', mobile: false });
	});

	it('provides a safe unknown fallback without navigator', async () => {
		vi.stubGlobal('navigator', undefined);
		expect(detectBrowser()).toEqual({ browser: 'other', mobile: false });
		expect(await detectBrowserWithBrave()).toEqual({ browser: 'other', mobile: false });
	});
});
