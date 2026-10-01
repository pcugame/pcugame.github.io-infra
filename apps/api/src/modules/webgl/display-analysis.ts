import { createHash } from 'node:crypto';
import { UNITY_DEFAULT_SCRIPT_DIGEST, UNITY_DEFAULT_CSS_PROFILE, UNITY_MINIMAL_SCRIPT_DIGEST } from './unity-template-profile.js';
import { posix } from 'node:path';
import { parse as parseHtml, type DefaultTreeAdapterMap } from 'parse5';
import * as css from 'css-tree';
import { parse as parseJs } from 'acorn';
import yauzl from 'yauzl';
import type { WebglDisplayAnalysis } from '@pcu/contracts';
import type { WebglArchiveLayout } from './archive.js';

const FILE_LIMIT = 256 * 1024;
const TOTAL_LIMIT = 1024 * 1024;
const FILE_COUNT_LIMIT = 8;
export const unknownWebglDisplay = (reason: string): WebglDisplayAnalysis => ({ version: 1, kind: 'unknown', width: null, height: null, reason });
class Unsupported extends Error {}
function unsupported(reason: string): never { throw new Unsupported(reason); }
type HtmlNode = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
const attribute = (node: Element, name: string) => node.attrs.find((attr) => attr.name === name)?.value;
function nodes(root: HtmlNode): HtmlNode[] {
	const result: HtmlNode[] = [];
	const queue = [root];
	while (queue.length) {
		const node = queue.pop()!;
		result.push(node);
		if (result.length > 12_000) unsupported('html-complexity-limit');
		if ('childNodes' in node) queue.push(...node.childNodes);
	}
	return result;
}
function localReference(reference: string): string {
	if (!reference || /[\\?#%:]/.test(reference) || reference.startsWith('/') || reference.split('/').includes('..')) unsupported('non-local-reference');
	const normalized = posix.normalize(reference);
	if (normalized.startsWith('../') || normalized === '.') unsupported('non-local-reference');
	return normalized;
}

/** Reads only validated hosted paths; both declared and streamed text sizes are capped. */
export async function analyzeWebglDisplayArchive(input: { archivePath: string; layout: WebglArchiveLayout; signal?: AbortSignal }): Promise<WebglDisplayAnalysis> {
	try {
		const zip = await yauzl.openPromise(input.archivePath, { autoClose: false, lazyEntries: true, validateEntrySizes: true, strictFileNames: true });
		try {
			const entries = new Map<string, yauzl.Entry>();
			for await (const entry of zip.eachEntry()) {
				if (input.signal?.aborted) throw input.signal.reason;
				const hosted = input.layout.files.get(entry.fileName);
				if (hosted) entries.set(hosted, entry);
			}
			let total = 0;
			const texts = new Map<string, string>();
			const read = async (path: string): Promise<string> => {
				if (texts.has(path)) return texts.get(path)!;
				const entry = entries.get(path);
				if (!entry) unsupported('missing-local-reference');
				if (texts.size >= FILE_COUNT_LIMIT || entry.uncompressedSize > FILE_LIMIT || total + entry.uncompressedSize > TOTAL_LIMIT) unsupported('text-budget-exceeded');
				const stream = await zip.openReadStreamPromise(entry);
				const chunks: Buffer[] = [];
				let size = 0;
				try {
					for await (const chunk of stream) {
						if (input.signal?.aborted) throw input.signal.reason;
						const bytes = Buffer.from(chunk);
						size += bytes.length;
						if (size > FILE_LIMIT || total + size > TOTAL_LIMIT) unsupported('text-budget-exceeded');
						chunks.push(bytes);
					}
				} finally { stream.destroy(); }
				if (size !== entry.uncompressedSize) unsupported('text-size-mismatch');
				total += size;
				const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
				texts.set(path, text);
				return text;
			};
			const html = await read('index.html');
			return await analyzeWebglDisplay(html, read, new Set(entries.keys()));
		} finally { zip.close(); }
	} catch (error) {
		if (input.signal?.aborted) throw input.signal.reason;
		return unknownWebglDisplay(error instanceof Unsupported ? error.message : 'analysis-error');
	}
}

/** A deliberately narrow Unity template recognizer, not a browser layout engine. */
export async function analyzeWebglDisplay(html: string, readLocal: (path: string) => Promise<string>, localPaths?: ReadonlySet<string>): Promise<WebglDisplayAnalysis> {
	try {
		if (Buffer.byteLength(html) > FILE_LIMIT) unsupported('text-budget-exceeded');
		let totalTextBytes = Buffer.byteLength(html);
		let textFiles = 1;
		const loaded = new Map<string, string>();
		const readBounded = async (path: string): Promise<string> => {
			if (loaded.has(path)) return loaded.get(path)!;
			if (++textFiles > FILE_COUNT_LIMIT) unsupported('text-budget-exceeded');
			const text = await readLocal(path);
			const bytes = Buffer.byteLength(text);
			if (bytes > FILE_LIMIT || (totalTextBytes += bytes) > TOTAL_LIMIT) unsupported('text-budget-exceeded');
			loaded.set(path, text);
			return text;
		};
		const htmlErrors: string[] = [];
		const document = parseHtml(html, { onParseError: (error) => htmlErrors.push(error.code) });
		if (document.mode !== 'no-quirks') unsupported('unsupported-document-mode');
		if (htmlErrors.length) unsupported('invalid-html');
		const elements = nodes(document).filter((node): node is Element => 'tagName' in node);
		const canvases = elements.filter((node) => node.tagName === 'canvas');
		if (canvases.length !== 1 || attribute(canvases[0]!, 'id') !== 'unity-canvas') unsupported('unsupported-canvas');
		const canvas = canvases[0]!;
		const ids = elements.map((node) => attribute(node, 'id')).filter(Boolean);
		if (elements.some((node) => attribute(node, 'id')?.startsWith('unity-') && node.tagName !== (attribute(node, 'id') === 'unity-canvas' ? 'canvas' : 'div'))) unsupported('unsupported-unity-element');
		if (attribute(canvas, 'class')) unsupported('unsupported-canvas-class');
		if (new Set(ids).size !== ids.length) unsupported('duplicate-html-id');
		const container = elements.find((node) => attribute(node, 'id') === 'unity-container');
		if (!container || !('tagName' in container.parentNode!) || container.parentNode.tagName !== 'body' || canvas.parentNode !== container) unsupported('unsupported-container');
		if (elements.some((node) => node.attrs.some((attr) => attr.name.startsWith('on')) || node.tagName === 'base' || (node.tagName === 'link' && !['stylesheet', 'shortcut icon', 'icon'].includes(attribute(node, 'rel') ?? '')))) unsupported('unsupported-html');
		const text = (node: Element) => ('childNodes' in node ? node.childNodes.filter((child) => child.nodeName === '#text').map((child) => (child as DefaultTreeAdapterMap['textNode']).value).join('') : '');
		const body = elements.find((node) => node.tagName === 'body')!;
		if (text(body).trim() || text(container).trim() || canvas.childNodes.some((node) => node.nodeName !== '#comment' && (node.nodeName !== '#text' || (node as DefaultTreeAdapterMap['textNode']).value.trim()))) unsupported('unsupported-html-content');
		if (elements.some((node) => !['html', 'head', 'meta', 'title', 'link', 'style', 'body', 'div', 'canvas', 'script'].includes(node.tagName))) unsupported('unsupported-html-element');
		if (body.childNodes.some((node) => 'tagName' in node && node !== container && node.tagName !== 'script')) unsupported('unsupported-body-content');
		if (elements.some((node) => node.attrs.some((attr) => attr.name === 'hidden' || (['class', 'style'].includes(attr.name) && node !== container && node !== canvas)))) unsupported('unsupported-html-attribute');
		for (const node of elements) {
			const allowed = node === container ? ['id', 'class'] : node === canvas ? ['id', 'width', 'height', 'tabindex', 'style'] : ({ html: ['lang'], head: [], body: [], div: ['id'], script: ['src'], style: [], link: ['rel', 'href'], meta: ['name', 'content', 'charset', 'http-equiv'], title: [] } as Record<string, string[]>)[node.tagName] ?? [];
			if (node.attrs.some((attr) => !allowed.includes(attr.name))) unsupported('unsupported-html-attribute');
			if (node.tagName === 'meta' && attribute(node, 'http-equiv') && attribute(node, 'http-equiv')?.toLowerCase() !== 'content-type') unsupported('unsupported-html-metadata');
		}
		let hasStaticLoader = false;
		const sheets: string[] = [];
		const scripts: string[] = [];
		for (const node of elements) {
			if (node.tagName === 'style') sheets.push(text(node));
			if (node.tagName === 'link' && attribute(node, 'rel') === 'stylesheet') sheets.push(await readBounded(localReference(attribute(node, 'href') ?? '')));
			if (node.tagName === 'script') {
				const src = attribute(node, 'src');
				// Unity's generated loader is runtime infrastructure, never analyzed or executed.
				if (src) {
					const path = localReference(src);
					if (localPaths && !localPaths.has(path)) unsupported('missing-local-reference');
					if (/^Build\/[^/]+\.loader\.js$/.test(path)) hasStaticLoader = true;
					else scripts.push(await readBounded(path));
				} else scripts.push(text(node));
			}
		}
		const rules = new Map<string, Map<string, string>>();
		for (const sheet of sheets) {
			const ast = css.parse(sheet, { positions: false });
			let count = 0;
			css.walk(ast, () => { if (++count > 12_000) unsupported('css-complexity-limit'); });
			if (ast.type !== 'StyleSheet') unsupported('unsupported-css');
			ast.children.forEach((rule) => {
				if (rule.type !== 'Rule' || rule.prelude?.type !== 'SelectorList') unsupported('unsupported-css-rule');
				const selector = css.generate(rule.prelude);
				if (rules.has(selector)) unsupported('conflicting-css');
				const declarations = new Map<string, string>();
				rule.block.children.forEach((declaration) => {
					if (declaration.type !== 'Declaration' || declaration.important || declarations.has(declaration.property)) unsupported('unsupported-css-declaration');
					declarations.set(declaration.property, css.generate(declaration.value));
				});
				rules.set(selector, declarations);
			});
		}
		const allowedSelectors = /^(?:body|html|html,body|body,html|#unity-container(?:\.unity-(?:desktop|mobile))?|#unity-canvas|\.unity-mobile #unity-canvas|#unity-(?:loading-bar|logo|progress-bar-empty|progress-bar-full|footer|webgl-logo|logo-title-footer|build-title|fullscreen-button|warning)|\.unity-mobile #unity-footer)$/;
		for (const selector of rules.keys()) if (!allowedSelectors.test(selector)) unsupported('unsupported-css-selector');
		const value = (selector: string, property: string) => rules.get(selector)?.get(property);
		const inline = new Map<string, string>();
		if (attribute(canvas, 'style')) {
			const ast = css.parse(attribute(canvas, 'style')!, { context: 'declarationList' });
			if (ast.type !== 'DeclarationList') unsupported('unsupported-inline-style');
			ast.children.forEach((declaration) => {
				if (declaration.type !== 'Declaration' || declaration.important || inline.has(declaration.property)) unsupported('conflicting-inline-style');
				inline.set(declaration.property, css.generate(declaration.value));
			});
		}
		if (elements.some((node) => attribute(node, 'style') && node !== canvas)) unsupported('unsupported-inline-style');
		const scriptSizes = inspectScripts(scripts);
		if (localPaths && scriptSizes.references?.some((path) => !localPaths.has(path))) unsupported('missing-local-reference');
		const px = (raw: string | undefined): number | undefined => raw && /^\d+px$/.test(raw) ? Number(raw.slice(0, -2)) : undefined;
		if ([...inline.keys()].some((key) => !['width', 'height', 'background'].includes(key))) unsupported('unsupported-inline-style');
		const sizes = (dimension: 'width' | 'height') => [attribute(canvas, dimension), inline.get(dimension), value('#unity-canvas', dimension), scriptSizes[dimension]].filter((item): item is string => item !== undefined).map((raw) => /^\d+$/.test(raw) ? Number(raw) : px(raw));
		const width = sizes('width'); const height = sizes('height');
		// Full viewport template must size both containing block and canvas, with no footer.
		const responsive = value('#unity-container', 'width') === '100%' && value('#unity-container', 'height') === '100%' && value('#unity-canvas', 'width') === '100%' && value('#unity-canvas', 'height') === '100%' && value('#unity-canvas', 'display') === 'block' && ['html,body', 'body,html'].some((selector) => value(selector, 'height') === '100%' && value(selector, 'margin') === '0') && !elements.some((node) => attribute(node, 'id') === 'unity-footer');
		if (responsive && container.childNodes.filter((node) => 'tagName' in node).length === 1 && scriptSizes.profile === 'responsive' && hasStaticLoader && !inline.size && rules.size === 3 && [...rules.get('#unity-container')!.keys()].every((key) => ['width', 'height'].includes(key)) && [...rules.get('#unity-canvas')!.keys()].every((key) => ['width', 'height', 'display'].includes(key)) && [...(rules.get('html,body') ?? rules.get('body,html'))!.keys()].every((key) => ['height', 'margin'].includes(key))) return { version: 1, kind: 'responsive', width: null, height: null, reason: 'unity-full-viewport' };
		if (!matchesDefaultStyles(rules)) unsupported('unsupported-css-profile');
		if (scriptSizes.profile !== 'fixed' || !scriptSizes.width || !scriptSizes.height) unsupported('unsupported-desktop-script');
		if (!width.length || !height.length || width.some((item) => item !== width[0]) || height.some((item) => item !== height[0]) || !width[0] || !height[0]) unsupported('conflicting-or-dynamic-size');
		if (width[0] < 100 || height[0] < 100 || width[0] > 8192 || height[0] > 8192) unsupported('unsupported-size');
		if (attribute(container, 'class') !== 'unity-desktop' || (value('#unity-container.unity-desktop', 'position') ?? value('#unity-container', 'position')) !== 'absolute' || value('#unity-container.unity-desktop', 'transform') !== 'translate(-50%,-50%)') unsupported('unsupported-desktop-layout');
		let footerHeight = 0;
		const footer = elements.find((node) => attribute(node, 'id') === 'unity-footer');
		if (!footer) unsupported('unsupported-footer');
		if (footer) {
			if (text(footer).trim()) unsupported('unsupported-footer-content');
			if (footer.parentNode !== container || value('#unity-footer', 'position') !== 'relative') unsupported('unsupported-footer');
			let footerWidth = 0;
			const children = footer.childNodes.filter((node): node is Element => 'tagName' in node);
			if (children.length !== 3 || children.map((child) => attribute(child, 'id')).sort().join(',') !== 'unity-build-title,unity-fullscreen-button,unity-logo-title-footer') unsupported('unsupported-footer');
			for (const child of children) {
				const selector = `#${attribute(child, 'id')}`;
				const childHeight = px(value(selector, 'height')) ?? px(value(selector, 'line-height'));
				if (!childHeight || !['left', 'right'].includes(value(selector, 'float') ?? '') || child.childNodes.some((node) => 'tagName' in node)) unsupported('unsupported-footer');
				if (childHeight !== 38) unsupported('unsupported-footer');
				if (selector === '#unity-build-title') {
					if (value(selector, 'font-size') !== '18px' || value(selector, 'font-family') !== 'arial' || value(selector, 'margin-right') !== '10px') unsupported('unsupported-footer');
					// Reserve a conservative 18px per title code point; long titles may wrap.
					footerWidth += text(child).length * 18 + 10;
				} else {
					const childWidth = px(value(selector, 'width'));
					if (!childWidth || value(selector, 'margin-right')) unsupported('unsupported-footer');
					footerWidth += childWidth;
				}
				footerHeight = Math.max(footerHeight, childHeight);
			}
			if (height[0] + 42 > 8192) unsupported('unsupported-size');
			if (footerWidth > width[0]) unsupported('unsupported-footer-wrap');
			if (rules.get('#unity-footer')?.size !== 1) unsupported('unsupported-footer');
		}
		if (container.childNodes.some((node) => 'tagName' in node && node !== canvas && node !== footer && !['unity-loading-bar', 'unity-warning'].includes(attribute(node, 'id') ?? ''))) unsupported('unsupported-container-content');
		return { version: 1, kind: 'fixed', width: width[0], height: height[0] + (footerHeight ? footerHeight + 4 : 0), reason: 'unity-default-desktop' };
	} catch (error) { return unknownWebglDisplay(error instanceof Unsupported ? error.message : 'analysis-error'); }
}

interface AstShape { type?: string; left?: AstShape; right?: AstShape; id?: AstShape; init?: AstShape; object?: AstShape; property?: AstShape; key?: AstShape; value?: unknown; name?: string; [key: string]: unknown }

// Match a parsed stock script, masking only verified desktop sizes and product metadata.
// We do not interpret arbitrary uploaded JavaScript or infer whether a callback runs.
function inspectScripts(scripts: string[]): { width?: string; height?: string; profile?: 'fixed' | 'responsive'; references?: string[] } {
	if (!scripts.length) return {};
	if (scripts.length !== 1) unsupported('unsupported-script-profile');
	const script = scripts[0]!;
	const ast = parseJs(script, { ecmaVersion: 'latest' });
	const result: { width?: string; height?: string } = {};
	let count = 0;
	const references: string[] = [];
	function normalize(value: unknown, depth = 0): unknown {
		if (++count > 20_000 || depth > 128) unsupported('js-complexity-limit');
		if (Array.isArray(value)) return value.map((item) => normalize(item, depth + 1));
		if (!value || typeof value !== 'object') return value;
		const node = value as AstShape;
		const output: AstShape = {};
		for (const [key, item] of Object.entries(node)) if (!['start', 'end', 'raw'].includes(key)) output[key] = normalize(item, depth + 1);
		if (node.type === 'AssignmentExpression' && node.left?.type === 'MemberExpression' && node.left?.object?.type === 'MemberExpression' && node.left?.object?.object?.name === 'canvas' && node.left?.object?.property?.name === 'style' && ['width', 'height'].includes(node.left?.property?.name ?? '')) {
			if (node.right?.type !== 'Literal' || typeof node.right?.value !== 'string' || !/^\d+px$/.test(node.right?.value)) unsupported('dynamic-script-layout');
			const dimension = node.left.property!.name as 'width' | 'height';
			if (result[dimension]) unsupported('conflicting-script-size');
			result[dimension] = node.right?.value;
			output.right!.value = '<size>';
		}
		if (node.type === 'VariableDeclarator' && node.id?.name === 'loaderUrl') {
			if (node.init?.type !== 'BinaryExpression' || node.init.operator !== '+' || node.init.left?.type !== 'Identifier' || node.init.left.name !== 'buildUrl' || node.init.right?.type !== 'Literal' || typeof node.init.right.value !== 'string' || !/^\/[^/]+\.loader\.js$/.test(node.init.right.value)) unsupported('non-local-loader');
			references.push('Build' + node.init.right.value);
			output.init!.right!.value = '<local-loader>';
		}
		if (node.type === 'Property' && ['dataUrl', 'frameworkUrl', 'codeUrl'].includes(node.key?.name ?? '') && (node.value as AstShape)?.type === 'BinaryExpression') {
			const expression = node.value as AstShape;
			const suffix = { dataUrl: /^\/[^/]+\.data(?:\.(?:gz|br))?$/, frameworkUrl: /^\/[^/]+\.framework\.js(?:\.(?:gz|br))?$/, codeUrl: /^\/[^/]+\.wasm(?:\.(?:gz|br))?$/ }[node.key!.name! as 'dataUrl' | 'frameworkUrl' | 'codeUrl'];
			if (expression.operator !== '+' || expression.left?.type !== 'Identifier' || expression.left.name !== 'buildUrl' || expression.right?.type !== 'Literal' || typeof expression.right.value !== 'string' || !suffix.test(expression.right.value)) unsupported('non-local-build');
			references.push('Build' + expression.right.value);
			(output.value as AstShape).right!.value = '<local-build>';
		}
		if (node.type === 'Property' && ['companyName', 'productName', 'productVersion'].includes(node.key?.name ?? '') && (node.value as AstShape)?.type === 'Literal') (output.value as AstShape).value = '<metadata>';
		return output;
	}
	const normalizedAst = normalize(ast);
	const digest = createHash('sha256').update(JSON.stringify(normalizedAst)).digest('hex');
	if (digest === UNITY_DEFAULT_SCRIPT_DIGEST) return { ...result, profile: 'fixed', references };
	// A functioning minimal Unity initializer with literal ZIP-local build URLs.
	const minimal = normalizedAst as AstShape;
	const queue: AstShape[] = [minimal];
	while (queue.length) {
		const node = queue.pop()!;
		if (node.type === 'Property' && ['dataUrl', 'frameworkUrl', 'codeUrl'].includes(node.key?.name ?? '')) {
			const literal = node.value as AstShape;
			if (literal.type !== 'Literal' || typeof literal.value !== 'string') unsupported('non-local-build');
			if (!/^Build\/[^/]+\.(?:data|framework\.js|wasm)(?:\.(?:gz|br))?$/.test(localReference(literal.value))) unsupported('non-local-build');
			references.push(literal.value);
			(node.value as AstShape).value = '<local-build>';
		}
		for (const value of Object.values(node)) {
			if (Array.isArray(value)) { for (const item of value) if (item && typeof item === 'object') queue.push(item as AstShape); }
			else if (value && typeof value === 'object') queue.push(value as AstShape);
		}
	}
	if (createHash('sha256').update(JSON.stringify(minimal)).digest('hex') === UNITY_MINIMAL_SCRIPT_DIGEST) return { profile: 'responsive', references };
	unsupported('unsupported-script-profile');
}

function matchesDefaultStyles(rules: Map<string, Map<string, string>>): boolean {
	const normalized = [...rules].map(([selector, declarations]) => [selector, [...declarations].filter(([property]) => property !== 'background' && !(selector === '#unity-canvas' && ['width', 'height'].includes(property))).sort(([a], [b]) => a.localeCompare(b))] as const).sort(([a], [b]) => a.localeCompare(b));
	return JSON.stringify(normalized) === UNITY_DEFAULT_CSS_PROFILE;
}
