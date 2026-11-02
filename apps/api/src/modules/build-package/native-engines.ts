import { posix } from 'node:path';
import { executableFormat } from './binary.js';
import { assertGodotPack } from './godot.js';
import type { PackageReader } from './reader.js';

function unitySerializedHeader(bytes: Buffer, size: number): boolean {
	if (bytes.length < 48) return false;
	const version = bytes.readUInt32BE(8);
	if (version < 9 || version > 22 || ![0, 1].includes(bytes[16]!)) return false;
	const metadata = version >= 22 ? bytes.readUInt32BE(20) : bytes.readUInt32BE(0);
	const total = version >= 22 ? Number(bytes.readBigUInt64BE(24)) : bytes.readUInt32BE(4);
	const data = version >= 22 ? Number(bytes.readBigUInt64BE(32)) : bytes.readUInt32BE(12);
	const header = version >= 22 ? 48 : 20;
	return (
		total === size &&
		metadata > 0 &&
		header + metadata <= data &&
		data < size &&
		/^\d{4}\.\d+\.\d+[abfp]/.test(bytes.toString('ascii', header, header + 32))
	);
}
/** Native adapters share the actual executable list, never filename-only runtime evidence. */
export async function inspectNativeEngines(
	reader: PackageReader,
	executables: string[],
	evidence: string[],
): Promise<string[]> {
	const engines = new Set<string>();
	for (const executable of executables) {
		const directory = posix.dirname(executable),
			name = posix.basename(executable).replace(/\.(exe|x86_64|x86)$/i, '');
		const appContents = /^(.*\.app\/Contents)\/MacOS$/.exec(directory)?.[1];
		const dataPath = appContents
			? posix.join(appContents, 'Resources/Data/globalgamemanagers')
			: posix.join(directory, name + '_Data/globalgamemanagers');
		const runtimePath = appContents
			? posix.join(appContents, 'Frameworks/UnityPlayer.dylib')
			: ['UnityPlayer.dll', 'UnityPlayer.so']
					.map((p) => posix.join(directory, p))
					.find((p) => reader.entries.has(p));
		if (reader.entries.has(dataPath) && runtimePath && reader.entries.has(runtimePath)) {
			const main = await reader.read(executable, 256 * 1024),
				runtime = await reader.read(runtimePath, 256 * 1024);
			if (
				main.includes(Buffer.from(posix.basename(runtimePath))) &&
				executableFormat(runtime, reader.entries.get(runtimePath)!.uncompressedSize, true) &&
				unitySerializedHeader(await reader.read(dataPath), reader.entries.get(dataPath)!.uncompressedSize)
			) {
				engines.add('Unity');
				evidence.push(`${executable} -> Unity runtime/player data`);
			}
		}
		const packPath = posix.join(directory, name + '.pck');
		const size = reader.entries.get(executable)!.uncompressedSize;
		// Bound semantic work independently of archive acceptance; larger unknown variants stay reviewable.
		if (size > 256 * 1024 * 1024) continue;
		let embedded: { offset: number; bytes: number } | undefined;
		const trailer = size >= 12 ? await reader.readRange(executable, size - 12, 12) : Buffer.alloc(0);
		if (trailer.length === 12 && trailer.toString('ascii', 8) === 'GDPC') {
			const length = Number(trailer.readBigUInt64LE(0));
			if (Number.isSafeInteger(length) && length >= 88 && length <= size - 12)
				embedded = { offset: size - 12 - length, bytes: length };
		}
		if (!reader.entries.has(packPath) && !embedded) continue;
		let marker = false,
			tail = Buffer.alloc(0);
		await reader.scan(executable, (chunk) => {
			const bytes = Buffer.concat([tail, chunk]);
			marker ||= bytes.includes(Buffer.from('Godot Engine'));
			tail = bytes.subarray(Math.max(0, bytes.length - 32));
		});
		if (!marker) continue;
		if (
			reader.entries.has(packPath) &&
			assertGodotPack(await reader.read(packPath), reader.entries.get(packPath)!.uncompressedSize)
		) {
			engines.add('Godot');
			evidence.push(`${executable} -> Godot runtime/external project pack`);
		} else if (embedded) {
			const pack = await reader.readRange(executable, embedded.offset, Math.min(embedded.bytes, 512 * 1024));
			// Embedded v1 uses executable-relative resource offsets. v2+ custom relocation remains reviewable.
			if (
				pack.length >= 8 &&
				pack.readUInt32LE(4) === 1 &&
				assertGodotPack(pack, size - 12, embedded.offset + 88)
			) {
				engines.add('Godot');
				evidence.push(`${executable} -> Godot embedded pack at ${embedded.offset}, ${embedded.bytes} bytes`);
			}
		}
	}
	return [...engines];
}
