import { protobufFields } from './protobuf.js';
import { ZipValidationError } from '../archive/bounded-zip-validator.js';
import { localPath, type PackageReader } from './reader.js';
import { wasmSectionScanner } from './binary.js';
import { scriptFacts } from './script-facts.js';
import type { LinkedScript } from './web-engines.js';

/** ARCI v4/v5 use network byte order and fixed 16-byte resource entries. */
export function defoldArchiveIndex(bytes: Buffer, indexBytes: number, dataBytes: number): boolean {
	if (bytes.length < 48) return false;
	const version = bytes.readUInt32BE(0);
	if (![4, 5].includes(version)) return false;
	const count = bytes.readUInt32BE(16),
		entries = bytes.readUInt32BE(20),
		hashes = bytes.readUInt32BE(24),
		hashLength = bytes.readUInt32BE(28);
	if (
		!count ||
		count > 100000 ||
		hashes < 48 ||
		![16, 20, 32, 64].includes(hashLength) ||
		hashes + count * 64 > indexBytes ||
		entries < hashes + count * 64 ||
		entries + count * 16 > indexBytes
	)
		throw new ZipValidationError('Invalid Defold archive directory');
	if (entries + count * 16 > bytes.length) return false;
	for (let i = 0; i < count; i++) {
		const at = entries + i * 16,
			offset = bytes.readUInt32BE(at),
			size = bytes.readUInt32BE(at + 4),
			compressed = bytes.readUInt32BE(at + 8);
		if (offset + (compressed === 0xffffffff ? size : compressed) > dataBytes)
			throw new ZipValidationError('Defold resource exceeds archive data');
	}
	return true;
}
export async function inspectDefoldWeb(
	reader: PackageReader,
	entry: string,
	scripts: LinkedScript[],
	evidence: string[],
	reasons: string[],
): Promise<boolean> {
	const bootstrap = scripts.find(
		(s) => /Module\.runApp\(/.test(s.text) && /archive_location_filter/.test(s.text),
	);
	const loader = scripts.find((s) => /archive_files\.json/.test(s.text) && /runApp\s*:/.test(s.text));
	if (!bootstrap || !loader) return false;
	// Only the exporter’s statically recoverable location filter; other filters go to review.
	const filter =
		/archive_location_filter\s*:\s*function\s*\(\s*(\w+)\s*\)\s*\{\s*return\s*\(?\s*(["'])(.*?)\2\s*\+\s*\1\s*\+\s*(["'])(.*?)\4\s*\)?\s*;?\s*\}/.exec(
			bootstrap.text,
		);
	if (!filter) return false;
	const manifestPath = localPath(entry, `${filter[3]}/archive_files.json${filter[5]}`);
	if (!manifestPath) return false;
	if (!reader.entries.has(manifestPath)) {
		reasons.push(`missing:${manifestPath}`);
		return false;
	}
	if (reader.entries.get(manifestPath)!.uncompressedSize > 512 * 1024) return false;
	let manifest: {
		content?: Array<{
			name: string;
			size: number;
			pieces: Array<{ name: string; offset: number }>;
		}>;
	};
	try {
		manifest = JSON.parse((await reader.read(manifestPath)).toString('utf8'));
	} catch {
		throw new ZipValidationError('Invalid Defold archive manifest');
	}
	if (!Array.isArray(manifest.content) || manifest.content.length > 10000) return false;
	const files = new Map<string, { size: number; prefix: Buffer }>();
	for (const file of manifest.content) {
		if (
			!file ||
			typeof file.name !== 'string' ||
			!Number.isSafeInteger(file.size) ||
			file.size < 0 ||
			!Array.isArray(file.pieces) ||
			file.pieces.length > 10000
		)
			throw new ZipValidationError('Invalid Defold archive pieces');
		let offset = 0;
		const chunks: Buffer[] = [];
		let prefixBytes = 0;
		for (const piece of file.pieces) {
			if (!piece || typeof piece.name !== 'string' || piece.offset !== offset)
				throw new ZipValidationError('Invalid Defold archive piece range');
			const path = localPath(manifestPath, piece.name);
			if (!path) return false;
			const resource = reader.entries.get(path);
			if (!resource) {
				reasons.push(`missing:${path}`);
				return false;
			}
			offset += resource.uncompressedSize;
			if (/\.(arci|projectc|dmanifest)$/.test(file.name) && prefixBytes < 512 * 1024) {
				const bytes = await reader.read(path, 512 * 1024 - prefixBytes);
				chunks.push(bytes);
				prefixBytes += bytes.length;
			}
		}
		if (offset !== file.size) throw new ZipValidationError('Defold archive size mismatch');
		files.set(file.name, { size: file.size, prefix: Buffer.concat(chunks) });
	}
	const index = files.get('game.arci'),
		data = files.get('game.arcd'),
		project = files.get('game.projectc'),
		dmanifest = files.get('game.dmanifest');
	if (
		!index ||
		!data ||
		!project ||
		!dmanifest ||
		!defoldArchiveIndex(index.prefix, index.size, data.size) ||
		!/\[bootstrap\][\s\S]*main_collection\s*=\s*\/[^\n]+\.collectionc/.test(project.prefix.toString('utf8'))
	)
		return false;
	if (dmanifest.prefix.length !== dmanifest.size) return false;
	const manifestData = protobufFields(dmanifest.prefix).get(1)?.[0];
	if (!manifestData) throw new ZipValidationError('Defold manifest has no data');
	const fields = protobufFields(manifestData);
	if (!fields.has(1) || !fields.has(3)) return false;
	const mainCollection = /main_collection\s*=\s*([^\r\n]+)/
		.exec(project.prefix.toString('utf8'))?.[1]
		?.trim();
	const resource = fields
		.get(3)!
		.map((bytes) => protobufFields(bytes))
		.find((fields) => fields.get(1)?.[0]?.toString('utf8') === mainCollection);
	const hashEnvelope = resource?.get(3)?.[0];
	const hash = hashEnvelope && protobufFields(hashEnvelope).get(1)?.[0];
	if (!hash || hash.length !== index.prefix.readUInt32BE(28)) return false;
	let indexed = false;
	for (
		let i = 0, count = index.prefix.readUInt32BE(16), start = index.prefix.readUInt32BE(24);
		i < count;
		i++
	)
		indexed ||= index.prefix.subarray(start + i * 64, start + i * 64 + hash.length).equals(hash);
	if (!indexed) throw new ZipValidationError('Defold bootstrap collection is absent from archive index');
	const wasmReference = [...scriptFacts(bootstrap.text).strings].find(
		(s) => s.endsWith('.wasm') && !/^dmengine/.test(s),
	);
	const wasmPath = wasmReference && localPath(entry, wasmReference);
	if (!wasmPath) return false;
	if (!reader.entries.has(wasmPath)) {
		reasons.push(`missing:${wasmPath}`);
		return false;
	}
	if (!scripts.some((s) => /WebAssembly/.test(s.text) && /wasmBinary/.test(s.text))) return false;
	const scanner = wasmSectionScanner();
	await reader.scan(wasmPath, scanner.consume);
	if (!scanner.valid()) throw new ZipValidationError('Invalid Defold Wasm');
	evidence.push(`${entry} -> Defold loader/Wasm/archive manifest/pieces/resource ranges`);
	return true;
}
