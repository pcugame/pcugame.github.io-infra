import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { playShellHeaders, renderPlayShell } from './runtime-ui.js';

const config = { API_PUBLIC_URL: 'https://api.test', WEB_PUBLIC_URL: 'https://web.test', PUBLIC_ASSET_ORIGIN: 'https://assets.test' };
const html = renderPlayShell(config, 163);
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;

// Execute the actual hashed shell, including events/session creation/iframe insertion.
// A small DOM keeps API tests independent of the frontend's jsdom dependency.
function shell(options: { renderer?: string; missing?: boolean; strictMissing?: boolean; strictFail?: boolean; rendererFail?: boolean; noDialogAPI?: boolean; fail?: boolean; lost?: boolean; brave?: boolean; bravePending?: Promise<boolean> } = {}) {
	class Element {
		textContent = ''; value = ''; src = ''; alt = ''; width = 0; height = 0; hidden = true; open = false; disabled = false;
		dataset = { projectId: '163', assetOrigin: 'https://assets.test', graphicsAssets: 'https://web.test/help/graphics-acceleration/' };
		href = 'https://web.test/projects/163'; children: Element[] = []; attributes: Record<string, string> = {};
		listeners: Record<string, ((event?: unknown) => void)[]> = {};
		addEventListener(name: string, handler: () => void) { (this.listeners[name] ??= []).push(handler); }
		click() { this.listeners.click?.forEach(fn => fn()); }
		change() { this.listeners.change?.forEach(fn => fn()); }
		replaceChildren(...children: Element[]) { this.children = children; }
		append(child: Element) { this.children.push(child); }
		setAttribute(name: string, value: string) { this.attributes[name] = value; }
		removeAttribute(name: string) { delete this.attributes[name]; }
		showModal() { if (options.noDialogAPI) throw new Error('unsupported'); this.open = true; }
		close() { this.open = false; }
		focus() {}
	}
	const elements = new Map<string, Element>();
	const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
	const loseContext = vi.fn();
	const probes: boolean[] = [];
	const getContext = vi.fn((_version: string, attributes: { failIfMajorPerformanceCaveat: boolean }) => {
		probes.push(attributes.failIfMajorPerformanceCaveat);
		if (options.fail || (attributes.failIfMajorPerformanceCaveat && options.strictFail)) throw new Error('probe unavailable');
		if (options.missing || (attributes.failIfMajorPerformanceCaveat && options.strictMissing)) return null;
		return {
			isContextLost: () => options.lost ?? false,
			getExtension: (name: string) => name === 'WEBGL_lose_context' ? { loseContext }
				: options.renderer ? { UNMASKED_RENDERER_WEBGL: 1 } : null,
			getParameter: () => { if (options.rendererFail) throw new Error('privacy restriction'); return options.renderer; },
		};
	});
	const document = {
		querySelector: () => get('main'), getElementById: get, head: get('head'), visibilityState: 'visible',
		addEventListener: vi.fn(), createElement: (tag: string) => tag === 'canvas' ? { getContext } : new Element(),
	};
	const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, data: {
		id: 'session', controlSecret: 'secret', projectTitle: 'Game', iframeUrl: `https://assets.test/runtime/${'a'.repeat(64)}/index.html`,
	} }) });
	const context = {
		document, fetch, URL, Date, WebAssembly: {}, setInterval: vi.fn(),
		window: { isSecureContext: true, crossOriginIsolated: true, addEventListener: vi.fn() },
		navigator: { userAgent: 'Chrome/150.0', brave: { isBrave: () => options.bravePending ?? Promise.resolve(options.brave ?? false) } },
		location: { reload: vi.fn(), assign: vi.fn() }, confirm: vi.fn(),
	};
	runInNewContext(script, context);
	return { get, fetch, loseContext, probes, options, context };
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('runtime shell graphics acceleration gate', () => {
	it.each(['llvmpipe (LLVM)', 'ANGLE SwiftShader', 'softpipe', 'Software Rasterizer', 'Microsoft Basic Render Driver'])('holds %s before any session/iframe, bypass starts only once', async renderer => {
		const run = shell({ renderer });
		expect(run.get('acceleration-gate').open).toBe(true);
		expect(run.fetch).not.toHaveBeenCalled();
		expect(run.get('game').children).toHaveLength(0);
		expect(run.loseContext).toHaveBeenCalledTimes(1);
		run.get('acceleration-continue').click(); run.get('acceleration-continue').click(); run.get('acceleration-retry').click();
		await settle();
		expect(run.fetch).toHaveBeenCalledTimes(1);
		expect(run.fetch.mock.calls[0]?.[1].body).toBe('{"projectId":163}');
		expect(run.get('game').children).toHaveLength(1);
		expect(run.get('game').children[0]?.attributes.sandbox).toBe('allow-scripts allow-pointer-lock allow-same-origin');
		expect(run.get('acceleration-gate').hidden).toBe(true);
	});
	it('no WebGL keeps a visible usable guide; retry succeeds once after settings change', async () => {
		const options = { missing: true, renderer: 'NVIDIA GPU' };
		const run = shell(options);
		expect(run.get('acceleration-gate').open).toBe(true);
		expect(run.probes).toEqual([false, false]);
		run.get('acceleration-retry').click();
		expect(run.fetch).not.toHaveBeenCalled();
		expect(run.get('acceleration-result').textContent).toContain('아직');
		options.missing = false;
		run.get('acceleration-retry').click(); run.get('acceleration-continue').click();
		await settle();
		expect(run.fetch).toHaveBeenCalledTimes(1);
		expect(run.loseContext).toHaveBeenCalledTimes(2);
	});
	it('strict performance caveat holds the gate and releases the probe context', () => {
		const run = shell({ renderer: 'NVIDIA', strictMissing: true });
		expect(run.fetch).not.toHaveBeenCalled();
		expect(run.probes).toEqual([false, true]);
		expect(run.loseContext).toHaveBeenCalledTimes(1);
	});
	it.each([{ renderer: 'NVIDIA' }, {}, { fail: true }, { lost: true }])('available or inconclusive renderer releases without claiming disabled: %j', async options => {
		const run = shell(options); await settle();
		expect(run.fetch).toHaveBeenCalledTimes(1);
		expect(run.get('acceleration-gate').hidden).toBe(true);
		if (!options.fail) expect(run.loseContext).toHaveBeenCalledTimes(2);
	});
	it.each([{ renderer: 'GPU', strictFail: true }, { renderer: 'GPU', rendererFail: true }])('probe errors remain inconclusive and release resources: %j', async options => {
		const run = shell(options); await settle();
		expect(run.fetch).toHaveBeenCalledTimes(1);
		expect(run.loseContext).toHaveBeenCalledTimes(options.strictFail ? 1 : 2);
	});
	it('shows the guide if dialog API fails and allows explicit continuation', async () => {
		const run = shell({ missing: true, noDialogAPI: true });
		expect(run.get('acceleration-gate').attributes.open).toBe('');
		expect(run.get('acceleration-gate').hidden).toBe(false);
		expect(run.fetch).not.toHaveBeenCalled();
		run.get('acceleration-continue').click(); await settle();
		expect(run.fetch).toHaveBeenCalledTimes(1);
		expect(run.get('acceleration-gate').attributes.open).toBeUndefined();
	});
	it('auto detects Brave, supports hidden-brand manual choice and does not overwrite it later', async () => {
		const run = shell({ missing: true, brave: true }); await settle();
		expect(run.get('guide-browser').value).toBe('brave');
		expect(run.get('guide-address').textContent).toBe('brave://settings/system');
		let resolve!: (value: boolean) => void;
		const pending = shell({ missing: true, bravePending: new Promise<boolean>(done => { resolve = done; }) });
		pending.get('guide-browser').value = 'firefox'; pending.get('guide-browser').change();
		resolve(true); await settle();
		expect(pending.get('guide-address-row').hidden).toBe(true);
		expect(pending.get('guide-image').src).toBe('https://web.test/help/graphics-acceleration/firefox-performance.png');
		pending.get('guide-browser').value = 'brave'; pending.get('guide-browser').change();
		expect(pending.get('guide-address').textContent).toBe('brave://settings/system');
	});
	it('preserves screenshot enlargement, nested Escape, manual guide content and image failure', () => {
		const run = shell({ missing: true });
		expect(run.get('guide-image').src).toBe('https://web.test/help/graphics-acceleration/chromium-system.webp');
		run.get('guide-preview').click();
		expect(run.get('guide-enlarged').open).toBe(true);
		const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
		run.get('guide-enlarged').listeners.cancel?.[0]?.(event);
		expect(event.preventDefault).toHaveBeenCalled();
		expect(event.stopPropagation).toHaveBeenCalled();
		expect(run.get('guide-enlarged').hidden).toBe(true);
		expect(run.get('acceleration-gate').open).toBe(true);
		expect(run.context.location.assign).not.toHaveBeenCalled();
		run.get('guide-preview').click(); run.get('guide-enlarged-close').click();
		expect(run.get('guide-enlarged').open).toBe(false);
		run.get('guide-browser').value = 'firefox'; run.get('guide-browser').change();
		expect(run.get('guide-name').textContent).toBe('Firefox · 컴퓨터');
		expect(run.get('guide-detection').textContent).toBe('직접 선택');
		expect(run.get('guide-steps').children[0]?.textContent).toContain('탭 및 탐색');
		expect(run.get('guide-help').href).toBe('https://support.mozilla.org/ko/kb/performance-settings');
		run.get('guide-image').listeners.error?.[0]?.();
		expect(run.get('guide-screenshot').hidden).toBe(true);
		expect(run.get('guide-steps').children).toHaveLength(3);
		run.get('guide-browser').value = 'mobile'; run.get('guide-browser').change();
		expect(run.get('guide-screenshot').hidden).toBe(true);
		expect(run.get('guide-help').hidden).toBe(true);
		expect(run.fetch).not.toHaveBeenCalled();
		run.get('acceleration-close').click();
		expect(run.context.location.assign).toHaveBeenCalledWith('https://web.test/projects/163');
	});
	it('handles failed session creation after explicit continue with a usable restart', async () => {
		const run = shell({ missing: true });
		run.fetch.mockRejectedValueOnce(new Error('Connection failed'));
		run.get('acceleration-continue').click(); await settle();
		expect(run.get('status').textContent).toBe('Connection failed');
		expect(run.get('restart').disabled).toBe(false);
		expect(run.get('game').children).toHaveLength(0);
	});
	it('hashes the exact inline script/style and preserves isolation policies', () => {
		const headers = playShellHeaders(config);
		for (const text of [script, html.match(/<style>([\s\S]*?)<\/style>/)![1]!]) {
			expect(headers['Content-Security-Policy']).toContain(`'sha256-${createHash('sha256').update(text).digest('base64')}'`);
		}
		expect(headers['Content-Security-Policy']).toContain('img-src https://web.test/help/graphics-acceleration/; font-src https://web.test/help/graphics-acceleration/PretendardVariable.woff2;');
		expect(html.match(/crossorigin="anonymous"/g)).toHaveLength(2);
		expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin');
		expect(headers['Cross-Origin-Embedder-Policy']).toBe('require-corp');
		expect(script).not.toMatch(/\balert\s*\(/);
	});
});
