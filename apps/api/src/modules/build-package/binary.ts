/** Bounded header/section validation. Unknown machines/versions remain reviewable. */
export function executableFormat(
	bytes: Buffer,
	fileBytes: number,
	allowLibrary = false,
): 'PE' | 'ELF' | 'MACHO' | null {
	const range = (offset: number, size: number) =>
		Number.isSafeInteger(offset) &&
		Number.isSafeInteger(size) &&
		offset >= 0 &&
		size >= 0 &&
		offset + size <= fileBytes;
	try {
		if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0xcafebabe) {
			const count = bytes.readUInt32BE(4);
			if (!count || count > 32 || 8 + count * 20 > bytes.length) return null;
			let executable = false;
			for (let i = 0; i < count; i++) {
				const at = 8 + i * 20,
					offset = bytes.readUInt32BE(at + 8),
					length = bytes.readUInt32BE(at + 12);
				if (!range(offset, length) || offset < 8 + count * 20) return null;
				if (
					offset < bytes.length &&
					executableFormat(
						bytes.subarray(offset, Math.min(offset + length, bytes.length)),
						length,
						allowLibrary,
					) === 'MACHO'
				)
					executable = true;
			}
			return executable ? 'MACHO' : null;
		}
		if (bytes.length >= 64 && bytes.toString('ascii', 0, 2) === 'MZ') {
			const pe = bytes.readUInt32LE(60);
			if (pe < 64 || pe + 24 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550) return null;
			const characteristics = bytes.readUInt16LE(pe + 22);
			if (
				!(characteristics & 2) ||
				(!allowLibrary && characteristics & 0x2000) ||
				bytes.readUInt16LE(pe + 4) === 0
			)
				return null;
			const sections = bytes.readUInt16LE(pe + 6),
				optionalSize = bytes.readUInt16LE(pe + 20);
			const optional = pe + 24,
				table = optional + optionalSize;
			if (!sections || sections > 96 || optionalSize < 96 || table + sections * 40 > bytes.length)
				return null;
			const magic = bytes.readUInt16LE(optional);
			if (magic !== 0x10b && magic !== 0x20b) return null;
			const entry = bytes.readUInt32LE(optional + 16);
			let executable = false;
			for (let i = 0; i < sections; i++) {
				const at = table + 40 * i,
					size = bytes.readUInt32LE(at + 16),
					start = bytes.readUInt32LE(at + 20);
				const virtual = bytes.readUInt32LE(at + 12),
					virtualSize = bytes.readUInt32LE(at + 8);
				if (!range(start, size)) return null;
				if (
					size > 0 &&
					(bytes.readUInt32LE(at + 36) & 0x20000000) !== 0 &&
					entry >= virtual &&
					entry < virtual + Math.max(size, virtualSize)
				)
					executable = true;
			}
			return executable ? 'PE' : null;
		}
		if (bytes.length >= 52 && bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) {
			const wide = bytes[4] === 2,
				little = bytes[5] === 1;
			if ((!wide && bytes[4] !== 1) || (!little && bytes[5] !== 2) || bytes[6] !== 1) return null;
			const u16 = (at: number) => (little ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at));
			const u32 = (at: number) => (little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at));
			const word = (at: number) =>
				wide ? Number(little ? bytes.readBigUInt64LE(at) : bytes.readBigUInt64BE(at)) : u32(at);
			if (![2, 3].includes(u16(16))) return null;
			const entry = word(24),
				table = word(wide ? 32 : 28),
				size = u16(wide ? 54 : 42),
				count = u16(wide ? 56 : 44);
			if (!count || count > 1024 || size < (wide ? 56 : 32) || table + size * count > bytes.length)
				return null;
			let executable = false;
			for (let i = 0; i < count; i++) {
				const at = table + i * size;
				if (u32(at) !== 1) continue;
				const offset = word(at + (wide ? 8 : 4)),
					address = word(at + (wide ? 16 : 8));
				const fileSize = word(at + (wide ? 32 : 16)),
					memSize = word(at + (wide ? 40 : 20));
				if (!range(offset, fileSize) || memSize < fileSize) return null;
				const flags = u32(at + (wide ? 4 : 24));
				if (
					fileSize > 0 &&
					flags & 1 &&
					((entry > 0 && entry >= address && entry < address + memSize) || (allowLibrary && u16(16) === 3))
				)
					executable = true;
			}
			return executable ? 'ELF' : null;
		}
		if (bytes.length >= 32 && [0xfeedface, 0xfeedfacf].includes(bytes.readUInt32LE(0))) {
			const wide = bytes.readUInt32LE(0) === 0xfeedfacf;
			if (!(allowLibrary ? [2, 6, 8] : [2]).includes(bytes.readUInt32LE(12))) return null;
			const count = bytes.readUInt32LE(16),
				commandBytes = bytes.readUInt32LE(20),
				header = wide ? 32 : 28;
			if (!count || count > 4096 || header + commandBytes > bytes.length) return null;
			let at = header,
				executable = false;
			for (let i = 0; i < count; i++) {
				const command = bytes.readUInt32LE(at),
					size = bytes.readUInt32LE(at + 4);
				if (size < 8 || at + size > header + commandBytes) return null;
				if (command === 1 || command === 0x19) {
					const is64 = command === 0x19;
					if (size < (is64 ? 72 : 56)) return null;
					const offset = is64 ? Number(bytes.readBigUInt64LE(at + 40)) : bytes.readUInt32LE(at + 32);
					const length = is64 ? Number(bytes.readBigUInt64LE(at + 48)) : bytes.readUInt32LE(at + 36);
					if (!range(offset, length)) return null;
					if (length && bytes.readUInt32LE(at + (is64 ? 60 : 44)) & 4) executable = true;
				}
				at += size;
			}
			return at === header + commandBytes && executable ? 'MACHO' : null;
		}
	} catch {
		return null;
	}
	return null;
}

export function unityDataStructure(bytes: Buffer, size: number): boolean {
	if (bytes.length < 20 || bytes.subarray(0, 16).toString('ascii') !== 'UnityWebData1.0\0') return false;
	// Unity's magic is a 16-byte C string (one trailing NUL in the web-data format).
	const header = bytes.readUInt32LE(16);
	if (header < 20 || header > bytes.length || header > size) return false;
	let at = 20,
		count = 0;
	while (at < header) {
		if (at + 12 > header) return false;
		const start = bytes.readUInt32LE(at),
			length = bytes.readUInt32LE(at + 4),
			name = bytes.readUInt32LE(at + 8);
		if (name < 1 || at + 12 + name > header || start < header || start + length > size) return false;
		at += 12 + name;
		count++;
	}
	return at === header && count > 0;
}

/** A streaming Wasm section envelope check; holds no code payload in memory. */
export function wasmSectionScanner() {
	let stage: 'magic' | 'id' | 'length' | 'payload' = 'magic';
	let magic = 0,
		id = 0,
		length = 0,
		shift = 0,
		remaining = 0,
		valid = true,
		code = false;
	const seen = new Set<number>();
	const signature = [0, 97, 115, 109, 1, 0, 0, 0];
	return {
		consume(bytes: Buffer) {
			for (let at = 0; at < bytes.length;) {
				if (!valid) return;
				if (stage === 'payload') {
					const skip = Math.min(remaining, bytes.length - at);
					at += skip;
					remaining -= skip;
					if (!remaining) stage = 'id';
					continue;
				}
				const byte = bytes[at++]!;
				if (stage === 'magic') {
					if (byte !== signature[magic++]) valid = false;
					if (magic === 8) stage = 'id';
				} else if (stage === 'id') {
					id = byte;
					if (id > 13 || (id !== 0 && seen.has(id))) valid = false;
					seen.add(id);
					length = shift = 0;
					stage = 'length';
				} else {
					length += (byte & 127) * 2 ** shift;
					shift += 7;
					if (shift > 35 || length > 0xffffffff) {
						valid = false;
						continue;
					}
					if (!(byte & 128)) {
						remaining = length;
						if (id === 10 && length > 1) code = true;
						stage = remaining ? 'payload' : 'id';
					}
				}
			}
		},
		valid: () => valid && stage === 'id' && code && seen.has(1) && seen.has(3),
	};
}
