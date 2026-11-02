import { ZipValidationError } from '../archive/bounded-zip-validator.js';
/** Wire-envelope reader for AAPT2 XmlNode and bundletool config. Unknown fields are retained. */
export function protobufFields(bytes: Buffer): Map<number, Buffer[]> {
	const fields = new Map<number, Buffer[]>();
	let at = 0,
		count = 0;
	const invalid = (): never => {
		throw new ZipValidationError('Protobuf structure is invalid');
	};
	const integer = () => {
		let value = 0n;
		for (let shift = 0n; shift < 70n; shift += 7n) {
			if (at >= bytes.length) return invalid();
			const byte = bytes[at++]!;
			if (shift === 63n && byte > 1) return invalid();
			value |= BigInt(byte & 127) << shift;
			if (!(byte & 128)) return value;
		}
		return invalid();
	};
	while (at < bytes.length) {
		if (++count > 100000) return invalid();
		const tag = integer(),
			field = Number(tag >> 3n),
			wire = Number(tag & 7n);
		if (!field || field > 0x1fffffff) return invalid();
		if (wire === 0) integer();
		else if (wire === 1 || wire === 5) at += wire === 1 ? 8 : 4;
		else if (wire === 2) {
			const size = Number(integer());
			if (!Number.isSafeInteger(size) || size > bytes.length - at) return invalid();
			const values = fields.get(field) ?? [];
			values.push(bytes.subarray(at, at + size));
			fields.set(field, values);
			at += size;
		} else return invalid(); // AAPT2 uses proto3, which has no groups.
		if (at > bytes.length) return invalid();
	}
	return fields;
}
