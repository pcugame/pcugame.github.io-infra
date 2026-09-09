import { promises as fileSystem } from 'node:fs';
import {
	MAX_EOCD_SEARCH_BYTES,
	validateZipArchive,
	type ZipValidationSummary,
} from './zip-validation.js';

async function validateZipArchiveFileWithOptions(
	filePath: string,
	sizeBytes: number | undefined,
	options: { allowGzipEntries?: boolean },
): Promise<ZipValidationSummary> {
	const stat = sizeBytes == null ? await fileSystem.stat(filePath) : { size: sizeBytes };
	const tailLength = Math.min(stat.size, MAX_EOCD_SEARCH_BYTES);
	const tailStart = stat.size - tailLength;
	const handle = await fileSystem.open(filePath, 'r');

	try {
		const tail = Buffer.alloc(tailLength);
		await handle.read(tail, 0, tailLength, tailStart);
		return await validateZipArchive({
			sizeBytes: stat.size,
			eocdTail: tail,
			tailStartOffset: tailStart,
			allowGzipEntries: options.allowGzipEntries,
			readRange: async (start, end) => {
				const length = end - start + 1;
				const buffer = Buffer.alloc(length);
				const { bytesRead } = await handle.read(buffer, 0, length, start);
				return buffer.subarray(0, bytesRead);
			},
		});
	} finally {
		await handle.close();
	}
}

export function validateZipArchiveFile(
	filePath: string,
	sizeBytes?: number,
): Promise<ZipValidationSummary> {
	return validateZipArchiveFileWithOptions(filePath, sizeBytes, {});
}

export function validateWebglZipArchiveFile(
	filePath: string,
	sizeBytes?: number,
): Promise<ZipValidationSummary> {
	return validateZipArchiveFileWithOptions(
		filePath,
		sizeBytes,
		{ allowGzipEntries: true },
	);
}
