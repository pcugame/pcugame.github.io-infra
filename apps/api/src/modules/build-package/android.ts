import { protobufFields } from './protobuf.js';
export { protobufFields } from './protobuf.js';
import { ZipValidationError } from '../archive/bounded-zip-validator.js';
/** Android binary XML chunk/string-pool parser; unsupported XML stays reviewable. */
export function androidManifest(bytes: Buffer): {
	application: boolean;
	unsupported: boolean;
} {
	const invalid = (): never => {
		throw new ZipValidationError('Android manifest structure is invalid');
	};
	if (
		bytes.length < 8 ||
		bytes.readUInt16LE(0) !== 3 ||
		bytes.readUInt16LE(2) !== 8 ||
		bytes.readUInt32LE(4) !== bytes.length
	)
		return invalid();
	let strings: string[] = [],
		application = false,
		offset = 8;
	const stack: string[] = [];
	try {
		while (offset < bytes.length) {
			const type = bytes.readUInt16LE(offset),
				header = bytes.readUInt16LE(offset + 2),
				size = bytes.readUInt32LE(offset + 4);
			if (header < 8 || size < header || offset + size > bytes.length) return invalid();
			const chunk = bytes.subarray(offset, offset + size);
			if (type === 1) {
				if (header < 28) return invalid();
				const count = chunk.readUInt32LE(8),
					flags = chunk.readUInt32LE(16),
					start = chunk.readUInt32LE(20);
				if (count > 65536 || header + 4 * count > start || start > size) return invalid();
				strings = [];
				for (let i = 0; i < count; i++) {
					let at = start + chunk.readUInt32LE(header + 4 * i);
					if (at >= size) return invalid();
					if (flags & 0x100) {
						const length = () => {
							const a = chunk[at++]!;
							if (a === undefined) return invalid();
							if (a & 128) {
								const b = chunk[at++]!;
								if (b === undefined) return invalid();
								return ((a & 127) << 8) | b;
							}
							return a;
						};
						length();
						const count = length();
						if (at + count >= size || chunk[at + count] !== 0) return invalid();
						strings.push(new TextDecoder('utf-8', { fatal: true }).decode(chunk.subarray(at, at + count)));
					} else {
						let count = chunk.readUInt16LE(at);
						at += 2;
						if (count & 0x8000) {
							count = (count & 0x7fff) * 65536 + chunk.readUInt16LE(at);
							at += 2;
						}
						if (at + count * 2 + 2 > size || chunk.readUInt16LE(at + count * 2) !== 0) return invalid();
						strings.push(chunk.toString('utf16le', at, at + count * 2));
					}
				}
			} else if (type === 0x102) {
				if (header < 16 || size < 36) return invalid();
				const name = strings[chunk.readUInt32LE(20)],
					attrStart = 16 + chunk.readUInt16LE(24),
					attrSize = chunk.readUInt16LE(26),
					count = chunk.readUInt16LE(28);
				if (!name || attrSize < 20 || attrStart + attrSize * count > size || stack.length > 1024)
					return invalid();
				if (!stack.length && name !== 'manifest') return invalid();
				for (let i = 0; i < count; i++)
					if (strings[chunk.readUInt32LE(attrStart + i * attrSize + 4)] === undefined) return invalid();
				if (name === 'application' && stack[0] === 'manifest') application = true;
				stack.push(name);
			} else if (type === 0x103) {
				if (header < 16 || size < 24 || stack.pop() !== strings[chunk.readUInt32LE(20)]) return invalid();
			} else if (![0x100, 0x101, 0x104, 0x180].includes(type)) return { application, unsupported: true };
			offset += size;
		}
		if (stack.length || !strings.length) return invalid();
		return { application, unsupported: false };
	} catch (error) {
		if (error instanceof ZipValidationError) throw error;
		return invalid();
	}
}
export function dexStructure(bytes: Buffer, fileBytes: number): 'valid' | 'unsupported' | 'invalid' {
	if (bytes.length < 112 || !/^dex\n\d{3}\0$/.test(bytes.toString('ascii', 0, 8))) return 'invalid';
	const version = Number(bytes.toString('ascii', 4, 7));
	if (![35, 37, 38, 39, 40].includes(version)) return 'unsupported';
	if (
		bytes.readUInt32LE(32) !== fileBytes ||
		bytes.readUInt32LE(36) !== 112 ||
		bytes.readUInt32LE(40) !== 0x12345678
	)
		return 'invalid';
	for (const [countAt, offsetAt, width] of [
		[56, 60, 4],
		[64, 68, 4],
		[72, 76, 12],
		[80, 84, 8],
		[88, 92, 8],
		[96, 100, 32],
		[104, 108, 1],
	]) {
		const count = bytes.readUInt32LE(countAt),
			offset = bytes.readUInt32LE(offsetAt);
		if (count && (offset < 112 || offset + count * width! > fileBytes)) return 'invalid';
	}
	return bytes.readUInt32LE(96) > 0 && bytes.readUInt32LE(104) > 0 ? 'valid' : 'invalid';
}

export function androidBundleManifest(bytes: Buffer): {
	application: boolean;
	unsupported: boolean;
} {
	const nodes = [{ bytes, depth: 0 }];
	let application = false,
		visited = 0;
	while (nodes.length) {
		const node = nodes.pop()!;
		if (++visited > 10000 || node.depth > 128) return { application, unsupported: true };
		const fields = protobufFields(node.bytes),
			elements = fields.get(1);
		if (!elements?.length) {
			if (fields.has(2)) continue; // XmlNode.text
			return { application, unsupported: true };
		}
		if (elements.length !== 1) throw new ZipValidationError('Android manifest has multiple node values');
		const element = protobufFields(elements[0]!);
		const name = element.get(3)?.[0]?.toString('utf8');
		if (!name) return { application, unsupported: true };
		if (node.depth === 0 && name !== 'manifest')
			throw new ZipValidationError('Android manifest root is invalid');
		if (node.depth === 1 && name === 'application') application = true;
		for (const child of element.get(5) ?? []) nodes.push({ bytes: child, depth: node.depth + 1 });
	}
	return { application, unsupported: false };
}
