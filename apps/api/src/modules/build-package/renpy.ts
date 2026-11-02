import { ZipValidationError } from '../archive/bounded-zip-validator.js';
import { localPath, type PackageReader } from './reader.js';
import { wasmSectionScanner } from './binary.js';
import { scriptFacts } from './script-facts.js';
import { record, type LinkedScript } from './web-engines.js';

export function renpyCompiledScript(bytes: Buffer, size: number): boolean {
	if (bytes.toString('ascii', 0, 10) !== 'RENPY RPC2') return false;
	let at = 10,
		slots = 0;
	while (at + 12 <= bytes.length && slots < 64) {
		const slot = bytes.readUInt32LE(at),
			offset = bytes.readUInt32LE(at + 4),
			length = bytes.readUInt32LE(at + 8);
		at += 12;
		if (!slot) return slots > 0;
		if (!length || offset < at || offset + length > size)
			throw new ZipValidationError('Invalid RenPy compiled script ranges');
		slots++;
	}
	return false;
}
export async function renpyScriptEvidence(reader: PackageReader): Promise<boolean> {
	let count = 0;
	for (const [path, entry] of reader.entries) {
		if (!/(^|\/)game\/.*\.rpyc?$/.test(path)) continue;
		if (++count > 32) return false;
		const bytes = await reader.read(path);
		if (
			path.endsWith('.rpyc')
				? renpyCompiledScript(bytes, entry.uncompressedSize)
				: /^\s*label\s+(?:start|\w+)\s*(?:\([^\n]*\))?\s*:/m.test(bytes.toString('utf8'))
		)
			return true;
	}
	return false;
}
export async function inspectRenpyWeb(
	reader: PackageReader,
	entry: string,
	scripts: LinkedScript[],
	containers: string[],
	evidence: string[],
	reasons: string[],
): Promise<boolean> {
	const bootstrap = scripts.find(
		(s) => /renpy/i.test(s.text) && /fetch\(['"]game\.zip['"]\)/.test(s.text) && /FS\.open/.test(s.text),
	);
	if (!bootstrap) return false;
	const game = localPath(entry, 'game.zip');
	if (!game || !reader.entries.has(game)) {
		if (game) reasons.push(`missing:${game}`);
		return false;
	}
	if (!containers.includes(`RenPy script payload: ${game}`)) return false;
	for (const script of scripts) {
		if (!/WebAssembly/.test(script.text) || !/FS_createPath/.test(script.text)) continue;
		const facts = scriptFacts(script.text),
			wasmName = facts.assignments.get('wasmBinaryFile'),
			dataName = facts.assignments.get('REMOTE_PACKAGE_NAME') ?? facts.assignments.get('REMOTE_PACKAGE_BASE');
		const metadata = facts.arguments
			.get('loadPackage')
			?.map((a) => record(a[0]))
			.find((v) => v?.remote_package_size);
		if (
			typeof wasmName !== 'string' ||
			typeof dataName !== 'string' ||
			!metadata ||
			!Array.isArray(metadata.files)
		)
			continue;
		const wasm = localPath(entry, wasmName),
			data = localPath(entry, dataName);
		if (!wasm || !data) continue;
		for (const path of [wasm, data]) if (!reader.entries.has(path)) reasons.push(`missing:${path}`);
		if (!reader.entries.has(wasm) || !reader.entries.has(data)) return false;
		const size = reader.entries.get(data)!.uncompressedSize;
		if (metadata.remote_package_size !== size)
			throw new ZipValidationError('RenPy runtime data size mismatch');
		let runtime = containers.includes(`RenPy runtime payload: ${game}`);
		for (const file of metadata.files) {
			const row = record(file);
			if (
				!row ||
				typeof row.filename !== 'string' ||
				!Number.isSafeInteger(row.start) ||
				!Number.isSafeInteger(row.end) ||
				Number(row.start) < 0 ||
				Number(row.end) < Number(row.start) ||
				Number(row.end) > size
			)
				throw new ZipValidationError('Invalid RenPy runtime payload range');
			runtime ||= /\/renpy\/.*\.pyc?$/.test(row.filename);
		}
		const scanner = wasmSectionScanner();
		await reader.scan(wasm, scanner.consume);
		if (!scanner.valid()) throw new ZipValidationError('Invalid RenPy Wasm');
		if (runtime) {
			evidence.push(`${entry} -> RenPy bootstrap/Wasm/runtime data/game ZIP/scripts`);
			return true;
		}
	}
	return false;
}
