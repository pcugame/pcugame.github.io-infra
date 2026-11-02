import { Writable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { createGunzip, createBrotliDecompress } from 'node:zlib';
import yauzl from 'yauzl';
import { posix } from 'node:path';
import { ZipValidationError, type BoundedZipValidationSummary } from '../archive/bounded-zip-validator.js';

export class InspectionBudgetExceeded extends Error {}
export async function openPackageReader(
	path: string,
	summary: BoundedZipValidationSummary,
	signal?: AbortSignal,
	expansionBudget?: { bytes: number },
) {
	const zip = await yauzl.openPromise(path, {
		autoClose: false,
		lazyEntries: true,
		strictFileNames: true,
		validateEntrySizes: true,
	});
	const rawEntries = new Map<string, yauzl.Entry>();
	try {
		for await (const entry of zip.eachEntry()) {
			signal?.throwIfAborted();
			rawEntries.set(entry.fileName, entry);
		}
	} catch (error) {
		zip.close();
		throw error;
	}
	const links = new Map(
		summary.entries.filter((e) => e.linkTarget !== undefined).map((e) => [e.path, e.linkTarget!]),
	);
	const resolve = (input: string): string => {
		let path = input;
		for (let step = 0; step < 128; step++) {
			const parts = path.split('/');
			let replaced = false;
			for (let end = parts.length; end > 0; end--) {
				const prefix = parts.slice(0, end).join('/'),
					target = links.get(prefix);
				if (target === undefined) continue;
				path = posix.join(target, ...parts.slice(end));
				replaced = true;
				break;
			}
			if (!replaced) return path;
		}
		throw new InspectionBudgetExceeded('internal-link-resolution-budget');
	};
	// Resolve aliases on lookup without expanding directory links into extra archive entries.
	const entries = new (class extends Map<string, yauzl.Entry> {
		override get(path: string) {
			return rawEntries.get(resolve(path));
		}
		override has(path: string) {
			return this.get(path) !== undefined;
		}
	})(rawEntries);
	let remaining = 32 * 1024 * 1024;
	const decodedRemaining = expansionBudget ?? {
		bytes: 10 * 1024 ** 3 - summary.decodedBytes,
	};
	const cache = new Map<string, Buffer>();
	return {
		entries,
		remainingAnalysisBytes() { return remaining; },
		async materialize(path: string, destination: Writable): Promise<void> {
			const entry = entries.get(path);
			if (!entry) throw new ZipValidationError(`Required local file is missing: ${path}`);
			try {
				await pipeline(await zip.openReadStreamPromise(entry), destination, { signal });
			} finally {
				destination.destroy();
				await finished(destination).catch(() => undefined);
			}
		},
		consumeExpansion(bytes: number) {
			decodedRemaining.bytes -= bytes;
			if (decodedRemaining.bytes < 0)
				throw new ZipValidationError('Web resource exceeds cumulative expansion budget');
		},
		async read(path: string, limit = 512 * 1024): Promise<Buffer> {
			const target = resolve(path);
			const key = `${target}:${limit}`;
			if (cache.has(key)) return cache.get(key)!;
			const entry = entries.get(target);
			if (!entry) throw new ZipValidationError(`Required local file is missing: ${path}`);
			const count = Math.min(entry.uncompressedSize, limit);
			if (count > remaining) throw new InspectionBudgetExceeded('inspection-byte-budget');
			remaining -= count;
			const body = await zip.openReadStreamPromise(entry);
			const chunks: Buffer[] = [];
			let read = 0;
			try {
				for await (const raw of body) {
					signal?.throwIfAborted();
					const chunk = Buffer.from(raw).subarray(0, count - read);
					chunks.push(chunk);
					read += chunk.length;
					if (read >= count) break;
				}
			} finally {
				body.destroy();
			}
			const result = Buffer.concat(chunks);
			cache.set(key, result);
			return result;
		},
		async readRange(path: string, offset: number, length: number): Promise<Buffer> {
			const entry = entries.get(path);
			if (
				!entry ||
				!Number.isSafeInteger(offset) ||
				!Number.isSafeInteger(length) ||
				offset < 0 ||
				length < 0 ||
				offset + length > entry.uncompressedSize
			)
				throw new ZipValidationError('Invalid package read range');
			if (length > remaining) throw new InspectionBudgetExceeded('inspection-byte-budget');
			remaining -= length;
			const body = await zip.openReadStreamPromise(entry),
				chunks: Buffer[] = [];
			let position = 0;
			try {
				for await (const raw of body) {
					signal?.throwIfAborted();
					const chunk = Buffer.from(raw),
						end = position + chunk.length;
					if (end > offset && position < offset + length)
						chunks.push(
							chunk.subarray(
								Math.max(0, offset - position),
								Math.min(chunk.length, offset + length - position),
							),
						);
					position = end;
					if (position >= offset + length) break;
				}
			} finally {
				body.destroy();
			}
			return Buffer.concat(chunks);
		},
		async scan(path: string, consume: (bytes: Buffer) => void, compression?: 'gzip' | 'br'): Promise<number> {
			const entry = entries.get(path);
			if (!entry) throw new ZipValidationError(`Required local file is missing: ${path}`);
			const source = await zip.openReadStreamPromise(entry);
			let total = 0;
			const sink = new Writable({
				write(raw, _encoding, done) {
					try {
						const bytes = Buffer.from(raw);
						total += bytes.length;
						if (compression) decodedRemaining.bytes -= bytes.length;
						if (total > 4 * 1024 ** 3 || decodedRemaining.bytes < 0)
							throw new ZipValidationError('Web resource exceeds cumulative expansion budget');
						consume(bytes);
						done();
					} catch (error) {
						done(error as Error);
					}
				},
			});
			try {
				if (compression)
					await pipeline(source, compression === 'gzip' ? createGunzip() : createBrotliDecompress(), sink, {
						signal,
					});
				else await pipeline(source, sink, { signal });
			} catch (error) {
				if (
					error &&
					typeof error === 'object' &&
					'code' in error &&
					['Z_DATA_ERROR', 'Z_BUF_ERROR', 'ERR_PADDING_2', 'ERR_EXUBERANT_NIBBLE'].includes(
						String(error.code),
					)
				)
					throw new ZipValidationError('Compressed web resource is corrupt', {
						cause: error,
					});
				throw error;
			}
			return total;
		},
		close() {
			zip.close();
		},
	};
}
export type PackageReader = Awaited<ReturnType<typeof openPackageReader>>;
/** URL resolution in the published archive namespace; external URLs are left to network policy. */
export function localPath(from: string, reference: string): string | null {
	if (!reference || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(reference)) return null;
	let decoded: string;
	try {
		decoded = decodeURIComponent(reference.split(/[?#]/, 1)[0]!);
	} catch {
		throw new ZipValidationError('Invalid local reference encoding');
	}
	if (decoded.includes('\\') || decoded.includes('\0'))
		throw new ZipValidationError('Unsafe local reference');
	const path = posix.normalize(
		decoded.startsWith('/') ? decoded.slice(1) : posix.join(posix.dirname(from), decoded),
	);
	if (path === '..' || path.startsWith('../'))
		throw new ZipValidationError('Local reference escapes package');
	return path;
}
