import { createHash } from 'node:crypto';
import type { FileSystem } from '../application/ports.js';
import type {
	CollectedUploadFile,
	MultipartRequestHasher,
} from '../application/upload-ports.js';

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, canonicalize(child)]),
		);
	}
	return value;
}

async function fileDigest(fileSystem: Pick<FileSystem, 'createReadStream'>, path: string) {
	const hash = createHash('sha256');
	for await (const chunk of fileSystem.createReadStream(path)) hash.update(Buffer.from(chunk));
	return hash.digest('hex');
}

export function createMultipartRequestHasher(
	fileSystem: Pick<FileSystem, 'createReadStream'>,
): MultipartRequestHasher {
	return {
		async hash(payload: unknown, inputFiles: readonly CollectedUploadFile[]): Promise<string> {
			const files = await Promise.all(inputFiles.map(async (file, index) => ({
				index,
				fieldname: file.fieldname,
				filename: file.filename,
				sha256: await fileDigest(fileSystem, file.tmpPath),
			})));
			return createHash('sha256')
				.update(JSON.stringify({ payload: canonicalize(payload), files }))
				.digest('hex');
		},
	};
}
