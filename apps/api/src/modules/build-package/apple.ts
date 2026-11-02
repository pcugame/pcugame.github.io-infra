import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ZipValidationError } from '../archive/bounded-zip-validator.js';
import { executableFormat } from './binary.js';
import type { PackageReader } from './reader.js';

const invalid = (): never => {
	throw new ZipValidationError('Application plist structure is invalid');
};
/** Read only the root dictionary and its executable string; no object instantiation or code execution. */
function readBundleExecutable(bytes: Buffer): string | null {
	let value: unknown;
	if (bytes.subarray(0, 8).toString('ascii') === 'bplist00') {
		if (bytes.length < 40) return invalid();
		const trailer = bytes.length - 32;
		const width = bytes[trailer + 6]!,
			refWidth = bytes[trailer + 7]!;
		const number = (at: number, size: number): number => {
			if (![1, 2, 4, 8].includes(size) || at < 0 || at + size > bytes.length) return invalid();
			let n = 0n;
			for (let i = 0; i < size; i++) n = n * 256n + BigInt(bytes[at + i]!);
			if (n > BigInt(Number.MAX_SAFE_INTEGER)) return invalid();
			return Number(n);
		};
		const count = number(trailer + 8, 8),
			root = number(trailer + 16, 8),
			table = number(trailer + 24, 8);
		if (
			!count ||
			count > 65536 ||
			root >= count ||
			table < 8 ||
			table + count * width > trailer ||
			![1, 2, 4, 8].includes(refWidth)
		)
			return invalid();
		const object = (index: number) => {
			if (index >= count) return invalid();
			const at = number(table + index * width, width);
			if (at < 8 || at >= table) return invalid();
			const marker = bytes[at]!,
				kind = marker >> 4;
			let length = marker & 15,
				start = at + 1;
			if (length === 15) {
				const integer = bytes[start++]!;
				if (integer >> 4 !== 1 || (integer & 15) > 3) return invalid();
				const size = 2 ** (integer & 15);
				length = number(start, size);
				start += size;
			}
			return { kind, length, start };
		};
		const string = (index: number) => {
			const obj = object(index),
				size = obj.length * (obj.kind === 6 ? 2 : 1);
			if (![5, 6].includes(obj.kind) || obj.start + size > table) return invalid();
			const raw = bytes.subarray(obj.start, obj.start + size);
			return obj.kind === 5
				? raw.toString('ascii')
				: new TextDecoder('utf-16be', { fatal: true }).decode(raw);
		};
		const dictionary = object(root);
		if (
			dictionary.kind !== 13 ||
			dictionary.length > 65536 ||
			dictionary.start + 2 * dictionary.length * refWidth > table
		)
			return invalid();
		for (let i = 0; i < dictionary.length; i++) {
			if (string(number(dictionary.start + i * refWidth, refWidth)) === 'CFBundleExecutable') {
				value = string(number(dictionary.start + (dictionary.length + i) * refWidth, refWidth));
				break;
			}
		}
	} else {
		const text = bytes.toString('utf8');
		if (XMLValidator.validate(text) !== true) return invalid();
		// Entities are not expanded. A custom/entity-heavy plist remains unrecognized.
		const parsed: unknown = new XMLParser({
			preserveOrder: true,
			ignoreAttributes: true,
			processEntities: false,
			parseTagValue: false,
			trimValues: false,
		}).parse(text);
		type Element = Record<string, unknown>;
		const nodes = (input: unknown): Element[] => (Array.isArray(input) ? (input as Element[]) : []);
		const plist = nodes(parsed).find((node) => 'plist' in node);
		const dictionary = nodes(plist?.plist).find((node) => 'dict' in node);
		if (!dictionary) return invalid();
		// preserveOrder retains indentation as text nodes between dictionary keys and values.
		const children = nodes(dictionary.dict).filter((node) => !('#text' in node));
		for (let i = 0; i < children.length; i++) {
			const key = nodes(children[i]?.key)
				.map((node) => node['#text'])
				.join('');
			if (key === 'CFBundleExecutable') {
				value = nodes(children[i + 1]?.string)
					.map((node) => node['#text'])
					.join('');
				break;
			}
		}
	}
	if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[/\\\x00-\x1f]/.test(value))
		return null;
	return value;
}
export function bundleExecutable(bytes: Buffer): string | null {
	try {
		return readBundleExecutable(bytes);
	} catch (error) {
		if (error instanceof ZipValidationError) throw error;
		throw new ZipValidationError('Application plist structure is invalid', {
			cause: error,
		});
	}
}
export async function inspectAppleBundles(reader: PackageReader, ipa = false): Promise<string[]> {
	const evidence: string[] = [];
	for (const [path, entry] of reader.entries) {
		const match = ipa
			? /^(Payload\/[^/]+\.app\/)Info\.plist$/.exec(path)
			: /^(.*\.app\/)Contents\/Info\.plist$/.exec(path);
		if (!match) continue;
		if (entry.uncompressedSize > 512 * 1024) {
			const codeRoot = match[1]! + (ipa ? '' : 'Contents/MacOS/');
			let found = false;
			for (const [candidate, code] of reader.entries) {
				if (
					!candidate.startsWith(codeRoot) ||
					candidate.slice(codeRoot.length).includes('/') ||
					code.uncompressedSize < 32
				)
					continue;
				const head = await reader.read(candidate, 4);
				if (![0xcafebabe, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(head.readUInt32BE()))
					continue;
				if (executableFormat(await reader.read(candidate, 256 * 1024), code.uncompressedSize) === 'MACHO') {
					found = true;
					break;
				}
			}
			if (!found) throw new ZipValidationError('Application bundle has no Mach-O executable');
			evidence.push(`Application manifest requires review: ${path}`);
			continue;
		}
		const executable = bundleExecutable(await reader.read(path));
		if (!executable) throw new ZipValidationError('Application manifest has no executable');
		const codePath = match[1]! + (ipa ? '' : 'Contents/MacOS/') + executable;
		const code = reader.entries.get(codePath);
		if (!code || executableFormat(await reader.read(codePath, 256 * 1024), code.uncompressedSize) !== 'MACHO')
			throw new ZipValidationError('Application manifest has no matching Mach-O executable');
		evidence.push(`Application manifest: ${path} -> ${codePath}`);
	}
	return evidence;
}
