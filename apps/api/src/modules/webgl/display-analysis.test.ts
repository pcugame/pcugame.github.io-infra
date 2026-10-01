import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { analyzeWebglDisplay } from './display-analysis.js';

const html = await readFile(new URL('./fixtures/unity-default.html', import.meta.url), 'utf8');
const css = await readFile(new URL('./fixtures/unity-default.css', import.meta.url), 'utf8');
const analyze = (markup = html, sheet = css) => analyzeWebglDisplay(markup, async (path) => {
	if (path !== 'TemplateData/style.css') throw new Error('unexpected path');
	return sheet;
});

describe('conservative Unity display analysis', () => {
	it('recognizes the real Unity 6000 desktop template including baseline gap and floated footer', async () => {
		expect(await analyze()).toEqual({ version: 1, kind: 'fixed', width: 960, height: 642, reason: 'unity-default-desktop' });
	});
	it.each(['', '.gz', '.br'])('accepts verified local build names with compression %s', async (suffix) => {
		const renamed = html.replaceAll('/Build.loader.js', '/MyGame.loader.js').replace('/Build.data', '/MyGame.data'+suffix).replace('/Build.framework.js', '/MyGame.framework.js'+suffix).replace('/Build.wasm', '/MyGame.wasm'+suffix);
		expect((await analyze(renamed)).kind).toBe('fixed');
	});
	it('does not let the stock mobile fullscreen branch classify desktop as responsive', async () => {
		expect((await analyze()).kind).toBe('fixed');
	});
	it('recognizes a full viewport profile without a footer', async () => {
		expect((await analyzeWebglDisplay('<!doctype html><html><head><style>html,body{height:100%;margin:0}#unity-container{width:100%;height:100%}#unity-canvas{width:100%;height:100%;display:block}</style></head><body><div id="unity-container"><canvas id="unity-canvas"></canvas></div><script src="Build/Build.loader.js"></script><script>createUnityInstance(document.querySelector("#unity-canvas"),{dataUrl:"Build/Build.data",frameworkUrl:"Build/Build.framework.js",codeUrl:"Build/Build.wasm",streamingAssetsUrl:"StreamingAssets",companyName:"DefaultCompany",productName:"Sample",productVersion:"1.0"});</script></body></html>', async () => '')).kind).toBe('responsive');
	});
	it.each([
		['missing doctype', html.replace('<!DOCTYPE html>', ''), css],
		['quirks doctype', html.replace('<!DOCTYPE html>', '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">'), css],
		['print stylesheet', html.replace('rel="stylesheet"', 'rel="stylesheet" media="print"'), css],
		['disabled stylesheet', html.replace('rel="stylesheet"', 'rel="stylesheet" disabled'), css],
		['deferred script', html.replace('<script>', '<script defer>'), css],
		['refresh metadata', html.replace('<head>', '<head><meta http-equiv="refresh" content="0;url=https://example.com">'), css],
		['footer text', html.replace('<div id="unity-footer">', '<div id="unity-footer">Extra'), css],
		['non-stock footer tag', html.replace('<div id="unity-footer">', '<fieldset id="unity-footer">').replace('    </div>\n    <script>', '    </fieldset>\n    <script>'), css],
		['non-stock footer child', html.replace('<div id="unity-build-title">', '<h1 id="unity-build-title">'), css],
		['conflicting CSS', html, css + '#unity-canvas{width:800px}'],
		['duplicate CSS', html, css + '#unity-canvas{background:red}'],
		['media query', html, css + '@media(min-width:800px){#unity-canvas{width:800px}}'],
		['unknown selector', html, css + 'canvas{padding:20px}'],
		['body font mutation', html, css.replace('body {', 'body { font-size:20px;')],
		['footer margin mutation', html, css.replace('#unity-footer {', '#unity-footer { margin-top:20px;')],
		['canvas padding', html, css.replace('#unity-canvas {', '#unity-canvas { padding:20px;')],
		['desktop offset', html, css.replace('left: 50%; top: 50%', 'left: 70%; top: 50%')],
		['hidden canvas', html.replace('id="unity-canvas" width', 'id="unity-canvas" hidden width'), css],
		['nested canvas', html.replace('<canvas id=', '<div><canvas id=').replace('</canvas>', '</canvas></div>'), css],
		['duplicate IDs', html.replace('<div id="unity-warning">', '<div id="unity-canvas">'), css],
		['arbitrary conditional sizing', html.replace('canvas.style.width = "960px";', 'if (false) {canvas.style.width = "960px";}'), css],
		['unexecuted sizing function', html.replace('canvas.style.width = "960px";', 'function never(){canvas.style.width = "960px";}'), css],
		['negated mobile predicate', html.replace('if (/iPhone', 'if (!/iPhone'), css],
		['dynamic sizing', html.replace('"960px"', 'window.innerWidth+"px"'), css],
		['unrecognized mobile predicate', html.replace('/iPhone|iPad|iPod|Android/i', '/Android/i'), css],
		['resize listener', html.replace('var canvas =', 'window.addEventListener("resize",()=>{}); var canvas ='), css],
		['unknown runtime function', html.replace('var canvas =', 'customResize(); var canvas ='), css],
		['remote stylesheet', html.replace('TemplateData/style.css', 'https://example.com/style.css'), css],
		['traversal stylesheet', html.replace('TemplateData/style.css', '../style.css'), css],
		['encoded stylesheet', html.replace('TemplateData/style.css', '%2e%2e/style.css'), css],
		['missing canvas', html.replace('id="unity-canvas"', 'id="game"'), css],
		['footer wrapping', html.replace('>Sample</div>', '>'+ 'Title'.repeat(100) + '</div>'), css],
	])('returns unknown for %s', async (_, markup, sheet) => { expect((await analyze(markup, sheet)).kind).toBe('unknown'); });
	it('fails open on read/parser failure', async () => {
		expect((await analyzeWebglDisplay(html, async () => { throw new Error('missing'); })).kind).toBe('unknown');
		expect((await analyze(html.replace('var canvas =', 'const =; var canvas ='))).kind).toBe('unknown');
	});
	it('caps text and AST depth', async () => {
		expect((await analyze(' '.repeat(256 * 1024 + 1))).reason).toBe('text-budget-exceeded');
		expect((await analyze(html.replace('var canvas =', 'var deep='+'('.repeat(200)+'1'+')'.repeat(200)+'; var canvas ='))).kind).toBe('unknown');
		expect((await analyze(html.replace('var canvas =', 'var deep='+'!'.repeat(200)+'true; var canvas ='))).kind).toBe('unknown');
	});
});
