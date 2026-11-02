import { inspectRenpyWeb } from './renpy.js';
import { followEngineScripts } from './web-links.js';
import { inspectDefoldWeb } from './defold.js';
import { inspectLinkedWebEngines } from './web-engines.js';
import { assertGodotPack } from './godot.js';
import { unityDataStructure, wasmSectionScanner } from './binary.js';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { parse as parseJavaScript } from 'acorn';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { ZipValidationError } from '../archive/bounded-zip-validator.js';
import { localPath, type PackageReader } from './reader.js';

/** Recognition hints alone NEVER authorize a build. Unverified export families go to review. */
const ENGINE_HINTS: Array<[string, RegExp]> = [
	['Unity', /\bcreateUnityInstance\b/],
	['Godot', /\bGODOT_CONFIG\b|\bnew\s+Engine\s*\(/],
	['GameMaker', /\bGameMaker_Init\b|\bg_pGMFile\b/],
	['RPG Maker MV/MZ', /\bScene_Boot\b|\brmmz_core\b|\brpg_core\b/],
	['Ren\u2019Py', /\brenpy\b/i],
	['Construct', /\bC3_CreateRuntime\b|\bcr_createRuntime\b/],
	['GDevelop', /\bgdjs\s*\./],
	['Defold', /\bDM_LOADER\b|\bModule\.runApp\b/],
	['Cocos Creator', /\bcc\.game\b|\bSystem\.import\(['"]\.\/application/],
	['PlayCanvas', /\bpc\.Application\b/],
	['Unreal', /\bUE4\b|\bUE5\b/],
];
type Node = { type?: string; [key: string]: unknown };
/** Evaluate only string literals, identifiers and concatenation. Never execute uploaded code. */
function staticStrings(script: string) {
	const values = new Map<string, string>(),
		properties = new Map<string, string>();
	const references = new Map<string, 'document' | 'module'>();
	const scriptElements = new Set<string>();
	let parsed: unknown;
	let unityCall = false,
		godotCall = false,
		godotStart = false;
	try {
		parsed = parseJavaScript(script, {
			ecmaVersion: 'latest',
			sourceType: 'module',
		});
	} catch {
		try {
			parsed = parseJavaScript(script, {
				ecmaVersion: 'latest',
				sourceType: 'script',
			});
		} catch {
			return {
				values,
				properties,
				references,
				unityCall,
				godotCall,
				godotStart,
				parsed: false,
			};
		}
	}
	const value = (n: unknown): string | undefined => {
		if (!n || typeof n !== 'object') return undefined;
		const node = n as Node;
		if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
		if (node.type === 'Identifier') return values.get(String(node.name));
		if (node.type === 'BinaryExpression' && node.operator === '+') {
			const left = value(node.left),
				right = value(node.right);
			if (left !== undefined && right !== undefined) return left + right;
		}
		return undefined;
	};
	const stack = [parsed];
	let nodes = 0;
	while (stack.length) {
		if (++nodes > 100_000)
			return {
				values,
				properties,
				references,
				unityCall,
				godotCall,
				godotStart,
				parsed: false,
			};
		const raw = stack.pop();
		if (!raw || typeof raw !== 'object') continue;
		const node = raw as Node;
		if (node.type === 'CallExpression' && (node.callee as Node)?.name === 'createUnityInstance')
			unityCall = true;
		if (node.type === 'NewExpression' && (node.callee as Node)?.name === 'Engine') godotCall = true;
		if (node.type === 'CallExpression' && ((node.callee as Node)?.property as Node)?.name === 'startGame')
			godotStart = true;
		if (node.type === 'VariableDeclarator') {
			const resolved = value(node.init),
				name = (node.id as Node)?.name;
			if (typeof name === 'string' && resolved !== undefined) values.set(name, resolved);
			const init = node.init as Node;
			if (
				typeof name === 'string' &&
				init?.type === 'CallExpression' &&
				((init.callee as Node)?.property as Node)?.name === 'createElement' &&
				(init.arguments as Node[])?.[0]?.value === 'script'
			)
				scriptElements.add(name);
		}
		if (node.type === 'Property') {
			const key = node.key as Node,
				resolved = value(node.value);
			const name = typeof key?.name === 'string' ? key.name : key?.value;
			if (typeof name === 'string' && resolved !== undefined) properties.set(name, resolved);
		}
		if (node.type === 'AssignmentExpression') {
			const left = node.left as Node,
				property = left?.property as Node,
				resolved = value(node.right);
			if (
				property?.name === 'src' &&
				resolved !== undefined &&
				scriptElements.has(String((left?.object as Node)?.name))
			)
				references.set(resolved, 'document');
		}
		if (
			node.type === 'ImportDeclaration' ||
			node.type === 'ExportNamedDeclaration' ||
			node.type === 'ExportAllDeclaration'
		) {
			const resolved = value(node.source);
			if (resolved?.startsWith('.')) references.set(resolved, 'module');
		}
		for (const child of Object.values(node).reverse()) {
			if (Array.isArray(child)) stack.push(...[...child].reverse());
			else if (child && typeof child === 'object') stack.push(child);
		}
	}
	return {
		values,
		properties,
		references,
		unityCall,
		godotCall,
		godotStart,
		parsed: true,
	};
}
export async function readWebResource(reader: PackageReader, path: string): Promise<Buffer> {
	const size = reader.entries.get(path)?.uncompressedSize ?? 0;
	if (size > 2 * 1024 * 1024) return reader.read(path);
	const bytes = await reader.read(path, 2 * 1024 * 1024);
	let decoded: Buffer | undefined;
	try {
		if (path.endsWith('.gz') || (path.endsWith('.unityweb') && bytes[0] === 31 && bytes[1] === 139))
			decoded = gunzipSync(bytes, { maxOutputLength: 4 * 1024 * 1024 });
		else if (path.endsWith('.br') || path.endsWith('.unityweb'))
			decoded = brotliDecompressSync(bytes, {
				maxOutputLength: 4 * 1024 * 1024,
			});
	} catch {
		return Buffer.alloc(0);
	} // Unsupported fallback/compression remains reviewable.
	if (decoded) {
		reader.consumeExpansion(decoded.length);
		return decoded;
	}

	return bytes;
}
export interface WebCandidate {
	path: string;
	engines: string[];
	confirmed: boolean;
	evidence: string[];
	reasons: string[];
}
export async function inspectWeb(reader: PackageReader, containers: string[] = []): Promise<WebCandidate[]> {
	const result: WebCandidate[] = [];
	for (const [path, entry] of reader.entries) {
		if (!/\.html?$/i.test(path)) continue;
		if (entry.uncompressedSize > 512 * 1024) {
			result.push({
				path,
				engines: [],
				confirmed: false,
				evidence: [],
				reasons: ['html-analysis-budget'],
			});
			continue;
		}
		const html = (await reader.read(path)).toString('utf8');
		const nodes: DefaultTreeAdapterMap['node'][] = [parse(html)];
		const scripts: Array<{ path: string; text: string }> = [];
		const evidence: string[] = [],
			reasons: string[] = [];
		let hasRuntime = false,
			count = 0;
		while (nodes.length) {
			if (++count > 20000) {
				reasons.push('html-complexity-budget');
				break;
			}
			const node = nodes.pop()!;
			if ('childNodes' in node) nodes.push(...node.childNodes);
			if (!('tagName' in node)) continue;
			const attr = (name: string) => node.attrs.find((a) => a.name === name)?.value;
			if (node.tagName === 'base') reasons.push('custom-base-url');
			if (node.tagName === 'canvas') hasRuntime = true;
			if (node.tagName === 'script') {
				hasRuntime = true;
				const src = attr('src'),
					resolved = src ? localPath(path, src) : null;
				if (resolved) {
					if (!reader.entries.has(resolved)) {
						reasons.push(`missing:${resolved}`);
						continue;
					}
					scripts.push({
						path: resolved,
						text: (await readWebResource(reader, resolved)).toString('utf8'),
					});
					evidence.push(`${path} -> ${resolved}`);
				} else if (!src)
					scripts.push({
						path,
						text: node.childNodes
							.filter((n) => n.nodeName === '#text')
							.map((n) => (n as DefaultTreeAdapterMap['textNode']).value)
							.join(''),
					});
				else evidence.push(`${path} -> external script (subject to existing network policy)`);
			}
			if (node.tagName === 'link' && ['stylesheet', 'manifest'].includes(attr('rel') ?? '')) {
				const ref = localPath(path, attr('href') ?? '');
				if (ref && !reader.entries.has(ref)) reasons.push(`missing:${ref}`);
			}
		}
		if (!hasRuntime) continue;
		await followEngineScripts(reader, path, scripts, readWebResource, evidence, reasons);
		const joined = scripts.map((s) => s.text).join('\n');
		const engines = ENGINE_HINTS.filter(([, pattern]) => pattern.test(joined)).map(([name]) => name);
		let unity = false,
			godot = false;
		for (const script of [...scripts]) {
			const parsed = staticStrings(script.text);
			for (const [reference, base] of parsed.references) {
				const resolved = localPath(base === 'module' ? script.path : path, reference);
				if (!resolved) continue;
				if (!reader.entries.has(resolved)) {
					reasons.push(`missing:${resolved}`);
					continue;
				}
				evidence.push(`${script.path} -> ${resolved}`);
				if (/\.js(?:\.(gz|br))?$/i.test(resolved) && !scripts.some((s) => s.path === resolved))
					scripts.push({
						path: resolved,
						text: (await readWebResource(reader, resolved)).toString('utf8'),
					});
			}
			if (parsed.godotCall && parsed.godotStart) {
				const executable = parsed.properties.get('executable');
				if (executable) {
					const packPath = localPath(path, parsed.properties.get('mainPack') ?? executable + '.pck');
					const wasmPath = localPath(path, executable + '.wasm');
					for (const ref of [packPath, wasmPath])
						if (ref && !reader.entries.has(ref)) reasons.push(`missing:${ref}`);
					if (packPath && wasmPath && reader.entries.has(packPath) && reader.entries.has(wasmPath)) {
						const pack = await reader.read(packPath);
						const wasm = wasmSectionScanner();
						await reader.scan(wasmPath, wasm.consume);
						godot =
							assertGodotPack(pack, reader.entries.get(packPath)!.uncompressedSize) &&
							wasm.valid() &&
							scripts.some(
								(s) =>
									s.path !== path &&
									/function Engine|var Engine/.test(s.text) &&
									/startGame/.test(s.text) &&
									/Godot/.test(s.text),
							);
						if (godot) evidence.push(`${path} -> Godot Engine/Wasm/project pack`);
					}
				} else reasons.push('dynamic-godot-configuration');
			}
			if (!parsed.unityCall) continue;
			for (const key of ['workerUrl', 'symbolsUrl']) {
				const ref = parsed.properties.get(key);
				const resolved = ref ? localPath(path, ref) : null;
				if (resolved && !reader.entries.has(resolved)) reasons.push(`missing:${resolved}`);
			}
			const paths = ['dataUrl', 'frameworkUrl', 'codeUrl'].map((key) => parsed.properties.get(key));
			if (paths.some((p) => !p)) {
				reasons.push('dynamic-unity-configuration');
				continue;
			}
			const resolved = paths.map((ref) => localPath(path, ref!));
			if (resolved.some((p) => !p)) {
				reasons.push('external-unity-payload');
				continue;
			}
			for (const ref of resolved) if (!reader.entries.has(ref!)) reasons.push(`missing:${ref}`);
			if (resolved.some((ref) => !reader.entries.has(ref!))) continue;
			const [dataPath, frameworkPath, wasmPath] = resolved as [string, string, string];
			const compression = async (name: string): Promise<'gzip' | 'br' | undefined> => {
				if (name.endsWith('.gz')) return 'gzip';
				if (name.endsWith('.br')) return 'br';
				if (name.endsWith('.unityweb')) {
					const head = await reader.read(name, 2);
					return head[0] === 31 && head[1] === 139 ? 'gzip' : 'br';
				}
				return undefined;
			};
			const chunks: Buffer[] = [];
			let headerBytes = 0;
			const dataSize = await reader.scan(
				dataPath,
				(chunk) => {
					if (headerBytes < 512 * 1024) {
						const head = chunk.subarray(0, 512 * 1024 - headerBytes);
						chunks.push(head);
						headerBytes += head.length;
					}
				},
				await compression(dataPath),
			);
			const wasm = wasmSectionScanner();
			await reader.scan(wasmPath, wasm.consume, await compression(wasmPath));
			const framework = await readWebResource(reader, frameworkPath);
			unity =
				unityDataStructure(Buffer.concat(chunks), dataSize) &&
				wasm.valid() &&
				/WebAssembly|wasmBinary/.test(framework.toString('utf8')) &&
				scripts.some((s) => /function\s+createUnityInstance|createUnityInstance\s*=/.test(s.text));
			if (unity) evidence.push(`${path} -> Unity loader/framework/Wasm/data`);
		}
		const linkedEngines = await inspectLinkedWebEngines(reader, path, scripts, evidence, reasons);
		if (await inspectDefoldWeb(reader, path, scripts, evidence, reasons)) linkedEngines.push('Defold');
		if (await inspectRenpyWeb(reader, path, scripts, containers, evidence, reasons))
			linkedEngines.push('Ren’Py');
		for (const engine of linkedEngines) if (!engines.includes(engine)) engines.push(engine);
		result.push({
			path,
			engines,
			confirmed: (unity || godot || linkedEngines.length > 0) && reasons.length === 0,
			evidence,
			reasons,
		});
	}
	return result;
}
