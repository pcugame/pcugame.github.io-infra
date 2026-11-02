import { localPath, type PackageReader } from './reader.js';
import { scriptFacts } from './script-facts.js';
import type { LinkedScript } from './web-engines.js';

/** Follow bounded, explicit exporter loader tables and SystemJS dependencies. */
export async function followEngineScripts(
	reader: PackageReader,
	entry: string,
	scripts: LinkedScript[],
	read: (reader: PackageReader, path: string) => Promise<Buffer>,
	evidence: string[],
	reasons: string[],
) {
	const add = async (base: string, reference: unknown) => {
		if (
			typeof reference !== 'string' ||
			!reference ||
			(!reference.startsWith('.') && !/\.(?:m?js)(?:[?#]|$)/.test(reference))
		)
			return;
		const path = localPath(base, reference);
		if (!path) return;
		if (!reader.entries.has(path)) {
			reasons.push(`missing:${path}`);
			return;
		}
		if (scripts.some((s) => s.path === path)) return;
		if (scripts.length >= 128) {
			reasons.push('script-dependency-budget');
			return;
		}
		scripts.push({ path, text: (await read(reader, path)).toString('utf8') });
		evidence.push(`${base} -> ${path}`);
	};
	for (let i = 0; i < scripts.length && i < 128; i++) {
		const script = scripts[i]!,
			facts = scriptFacts(script.text);
		if (script.path.endsWith('.json')) {
			try {
				const map = JSON.parse(script.text);
				if (map.imports && typeof map.imports === 'object')
					for (const url of Object.values(map.imports)) await add(script.path, url);
			} catch {
				reasons.push('unsupported-import-map');
			}
		}
		if (/SceneManager\.run\(Scene_Boot\)/.test(script.text)) {
			const urls = facts.assignments.get('scriptUrls');
			if (Array.isArray(urls)) for (const url of urls) await add(entry, url);
		}
		for (const args of facts.arguments.get('System.import') ?? []) await add(script.path, args[0]);
		for (const args of facts.arguments.get('System.register') ?? [])
			if (Array.isArray(args[0])) for (const dependency of args[0]) await add(script.path, dependency);
		for (const args of facts.arguments.get('self.RuntimeInterface') ?? []) {
			const options = args[0] as { engineScripts?: unknown; workerMainUrl?: unknown } | undefined;
			if (Array.isArray(options?.engineScripts))
				for (const url of options.engineScripts) await add(entry, url);
			await add(entry, options?.workerMainUrl);
		}
	}
}
