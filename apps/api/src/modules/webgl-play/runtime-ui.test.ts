import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { playShellHeaders, renderPlayShell } from './runtime-ui.js';

const config = { API_PUBLIC_URL: 'https://api.test', WEB_PUBLIC_URL: 'https://web.test', PUBLIC_ASSET_ORIGIN: 'https://assets.test' };

async function shell(width?: number | null, height?: number | null, kind?: 'fixed' | 'responsive' | 'legacy') {
	const events = new Map<string, () => void>();
	const windowEvents = new Map<string, () => void>();
	const classes = new Set<string>();
	let observer: (() => void) | undefined;
	let frames = 0;
	let replacements = 0;
	let requests = 0;
	const game = {
		clientWidth: 1600, clientHeight: 900,
		firstElementChild: null as null | { style: Record<string, string> },
		replaceChildren(frame?: { style: Record<string, string> }) { replacements++; this.firstElementChild = frame ?? null; },
	};
	function element() {
		return { style: {} as Record<string, string>, hidden: true, textContent: '', disabled: true,
			attributes: new Map<string, string>(), events: new Map<string, () => Promise<void>>(),
			setAttribute(name: string, value: string) { this.attributes.set(name, value); },
			addEventListener(name: string, handler: () => Promise<void>) { this.events.set(name, handler); },
		};
	}
	const fullscreen = element(), restart = element(), info = element(), status = element(), title = element();
	const root = {
		dataset: { projectId: '42', assetOrigin: 'https://assets.test' },
		classList: { add: (...names: string[]) => names.forEach(name => classes.add(name)) },
		async requestFullscreen() { document.fullscreenElement = root; events.get('fullscreenchange')?.(); },
	};
	const document = {
		fullscreenElement: null as null | typeof root,
		visibilityState: 'visible', title: '', head: { append() {} },
		querySelector: () => root,
		getElementById: (id: string) => ({ game, fullscreen, restart, 'display-info': info, status, title })[id],
		createElement(tag: string) { if (tag === 'iframe') frames++; return element(); },
		addEventListener: (name: string, handler: () => void) => events.set(name, handler),
		async exitFullscreen() { document.fullscreenElement = null; events.get('fullscreenchange')?.(); },
	};
	const code = renderPlayShell(config, 42).match(/<script>([\s\S]*)<\/script>/)![1]!;
	runInNewContext(code, {
		document, window: { isSecureContext: true, crossOriginIsolated: true, addEventListener: (name: string, handler: () => void) => windowEvents.set(name, handler) },
		WebAssembly: {}, URL, Date, setInterval() {}, location: { reload() { throw new Error('Unexpected session restart'); } },
		ResizeObserver: class { constructor(callback: () => void) { observer = callback; } observe() {} },
		fetch: async () => { requests++; return { ok: true, json: async () => ({ ok: true, data: {
			id: 'play', controlSecret: 'secret', iframeUrl: 'https://assets.test/runtime/' + 'a'.repeat(64) + '/index.html',
			projectTitle: 'Fixture', webglDisplayKind: kind, webglDisplayWidth: width, webglDisplayHeight: height,
		} }) }; },
	});
	await setImmediate();
	return { game, root, fullscreen, info, classes, resize: () => observer?.(), windowResize: () => windowEvents.get('resize')?.(), counts: () => ({ frames, replacements, requests }) };
}

describe('trusted shell display sizing', () => {
	it.each([[1280, 720], [720, 1280], [800, 600]])('fits %s × %s using available width and height while preserving iframe/session identity', async (width, height) => {
		const page = await shell(width, height);
		const frame = page.game.firstElementChild!;
		expect(frame.style.width).toBe(width + 'px');
		expect(frame.style.height).toBe(height + 'px');
		expect(frame.style.transform).toBe('translate(-50%, -50%) scale(' + Math.min(1600 / width, 900 / height, 1) + ')');
		page.game.clientWidth = 500; page.game.clientHeight = 300; page.resize();
		expect(frame.style.transform).toBe('translate(-50%, -50%) scale(' + Math.min(500 / width, 300 / height, 1) + ')');
		page.game.clientWidth = 2000; page.game.clientHeight = 1500; page.windowResize();
		expect(frame.style.transform).toBe('translate(-50%, -50%) scale(1)');
		await page.fullscreen.events.get('click')!();
		expect(frame.style.transform).toBe('translate(-50%, -50%) scale(' + Math.min(2000 / width, 1500 / height) + ')');
		expect(page.fullscreen.textContent).toBe('전체화면 나가기');
		await page.fullscreen.events.get('click')!();
		expect(frame.style.transform).toBe('translate(-50%, -50%) scale(1)');
		expect(page.game.firstElementChild).toBe(frame);
		expect(page.counts()).toEqual({ frames: 1, replacements: 1, requests: 1 });
	});
	it.each([[undefined, undefined], [null, null], [800, null], [8193, 600]])('preserves legacy layout for unset/invalid pair %s × %s', async (width, height) => {
		const page = await shell(width, height);
		expect(page.classes.size).toBe(0);
		expect(page.fullscreen.hidden).toBe(true);
		expect(page.info.hidden).toBe(true);
		expect(page.game.firstElementChild!.style).toEqual({});
	});

	it('fills the available area for responsive builds without recreating the iframe or session', async () => {
		const page = await shell(null, null, 'responsive');
		const frame = page.game.firstElementChild;
		expect(page.classes.has('responsive-display')).toBe(true);
		expect(page.fullscreen.hidden).toBe(false);
		expect(page.info.textContent).toContain('반응형');
		page.game.clientWidth = 420; page.game.clientHeight = 800; page.windowResize();
		await page.fullscreen.events.get('click')!();
		expect(page.fullscreen.textContent).toBe('전체화면 나가기');
		await page.fullscreen.events.get('click')!();
		expect(page.game.firstElementChild).toBe(frame);
		expect(page.counts()).toEqual({ frames: 1, replacements: 1, requests: 1 });
	});
	it('honors explicit legacy mode even when stale stored dimensions are present', async () => {
		const page = await shell(800, 600, 'legacy');
		expect(page.classes.size).toBe(0);
		expect(page.game.firstElementChild!.style).toEqual({});
	});
	it('hashes the exact shell script/style and preserves strict isolation headers', () => {
		const html = renderPlayShell(config, 42);
		const headers = playShellHeaders(config);
		for (const tag of ['script', 'style']) {
			const code = html.match(new RegExp('<' + tag + '>([\\s\\S]*)</' + tag + '>'))![1]!;
			expect(headers['Content-Security-Policy']).toContain("'sha256-" + createHash('sha256').update(code).digest('base64') + "'");
		}
		expect(headers['Content-Security-Policy']).not.toContain('unsafe-inline');
		expect(headers['Cross-Origin-Embedder-Policy']).toBe('require-corp');
		expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin');
	});
});
