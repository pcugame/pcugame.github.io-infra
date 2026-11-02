import { ZipValidationError } from '../archive/bounded-zip-validator.js';

/** PCK v1/v2/v3/v4 directory envelopes. Encrypted directories and sparse/delta packs require review. */
export function godotPackStructure(
	bytes: Buffer,
	fileBytes: number,
	minimumResourceOffset = 0,
): 'valid' | 'unsupported' | 'invalid' {
	if (bytes.length < 40 || bytes.toString('ascii', 0, 4) !== 'GDPC') return 'invalid';
	const version = bytes.readUInt32LE(4),
		flags = version === 1 ? 0 : bytes.readUInt32LE(20);
	if (![1, 2, 3, 4].includes(version) || (flags & ~2) !== 0) return 'unsupported';
	const base = version === 1 ? 0 : Number(bytes.readBigUInt64LE(24));
	let at = version === 1 ? 84 : version === 2 ? 96 : Number(bytes.readBigUInt64LE(32));
	const recordBytes = version === 1 ? 32 : 36;
	if (
		!Number.isSafeInteger(base) ||
		!Number.isSafeInteger(at) ||
		base > fileBytes ||
		at < 40 ||
		at + 4 > fileBytes
	)
		return 'invalid';
	if (at + 4 > bytes.length) return 'unsupported';
	const count = bytes.readUInt32LE(at);
	at += 4;
	if (!count) return 'invalid';
	if (count > 10000) return 'unsupported';
	let project = false,
		scene = false;
	const seen = new Set<string>();
	for (let i = 0; i < count; i++) {
		if (at + 4 > fileBytes) return 'invalid';
		if (at + 4 > bytes.length) return 'unsupported';
		const length = bytes.readUInt32LE(at);
		at += 4;
		if (!length || at + length + recordBytes > fileBytes) return 'invalid';
		if (at + length + recordBytes > bytes.length) return 'unsupported';
		const path = bytes
			.toString('utf8', at, at + length)
			.replace(/\0+$/, '')
			.replace(/^res:\/\//, '');
		at += length;
		if (
			!path ||
			path.startsWith('/') ||
			path.includes('\\') ||
			path.split('/').includes('..') ||
			seen.has(path)
		)
			return 'invalid';
		seen.add(path);
		const offset = base + Number(bytes.readBigUInt64LE(at)),
			size = Number(bytes.readBigUInt64LE(at + 8)),
			fileFlags = version === 1 ? 0 : bytes.readUInt32LE(at + 32);
		at += recordBytes;
		if (fileFlags & ~1) return 'unsupported';
		if (
			!Number.isSafeInteger(offset) ||
			!Number.isSafeInteger(size) ||
			offset < Math.max(base, minimumResourceOffset) ||
			offset + size > fileBytes
		)
			return 'invalid';
		project ||= /^(?:project\.binary|project\.godot)$/.test(path) && size > 0;
		scene ||= /\.(?:scn|tscn|gdc|gd)$/.test(path) && size > 0;
	}
	return project && scene ? 'valid' : 'unsupported';
}
export function assertGodotPack(bytes: Buffer, fileBytes: number, minimumResourceOffset = 0): boolean {
	const status = godotPackStructure(bytes, fileBytes, minimumResourceOffset);
	if (status === 'invalid') throw new ZipValidationError('Godot project pack structure is invalid');
	return status === 'valid';
}
