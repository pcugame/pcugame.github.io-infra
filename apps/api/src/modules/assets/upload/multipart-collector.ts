import { pipeline as streamPipeline } from 'node:stream/promises';
import path from 'node:path';
import type { FileSystem, IdGenerator } from '../../../application/ports.js';
import type { UploadLimits } from '../../../shared/upload-policy.js';
import {
	createByteLimiter,
	fieldnameToKind,
	kindLimit,
} from '../../../shared/upload-policy.js';
import { SIZE_LIMITS } from '../../../shared/file-signature.js';
import { payloadTooLarge } from '../../../shared/errors.js';
import { assertValidUploadFilename } from '../../../shared/filename-validation.js';
import type { MultipartPart } from '../../../application/http-input.js';
import type {
	CollectedUploadFile,
	MultipartCollectorPort,
	UploadPipelinePort,
} from '../../../application/upload-ports.js';

/** Multipart file part collected during submit */
export type CollectedFilePart = CollectedUploadFile;

interface MultipartCollectorDependencies {
	fileSystem: Pick<FileSystem,
		'createWriteStream' | 'stat' | 'temporaryDirectory'
	>;
	ids: IdGenerator;
}

/**
 * Collect multipart parts from a request stream.
 * Enforces per-file size limits, file count, and total request size.
 */
async function collectWithDependencies(
	deps: MultipartCollectorDependencies,
	parts: AsyncIterable<MultipartPart>,
	pipeline: UploadPipelinePort,
	limits: UploadLimits,
): Promise<{ payloadJson: string; fileParts: CollectedFilePart[] }> {
	let payloadJson = '';
	const fileParts: CollectedFilePart[] = [];
	let totalBytes = 0;

	for await (const part of parts) {
		if (part.type === 'field') {
			if (part.fieldname === 'payload' && typeof part.value === 'string') payloadJson = part.value;
		} else {
			const filename = part.filename;
			assertValidUploadFilename(filename);

			if (fileParts.length >= limits.maxFiles) {
				throw payloadTooLarge(`Too many files (max ${limits.maxFiles})`);
			}

			const fileKind = fieldnameToKind(part.fieldname);
			const basePerFileMax = fileKind ? kindLimit(limits, fileKind) : limits.imageMaxBytes;
			const perFileMax =
				fileKind === 'POSTER'
					? Math.max(basePerFileMax, SIZE_LIMITS.posterPdf)
					: fileKind === 'IMAGE'
					? Math.max(basePerFileMax, SIZE_LIMITS.imagePdf)
					: basePerFileMax;

			const tmpPath = path.join(
				deps.fileSystem.temporaryDirectory(),
				`pcu-project-upload-${deps.ids.next()}`,
			);
			pipeline.trackTempFile(tmpPath);

			const limiter = createByteLimiter(perFileMax, filename);
			await streamPipeline(part.file, limiter, deps.fileSystem.createWriteStream(tmpPath));

			const stat = await deps.fileSystem.stat(tmpPath);
			totalBytes += stat.size;
			if (totalBytes > limits.requestMaxBytes) {
				const limitMB = Math.round(limits.requestMaxBytes / 1024 / 1024);
				throw payloadTooLarge(`Total upload size exceeds ${limitMB}MB limit`);
			}

			fileParts.push({ tmpPath, fieldname: part.fieldname, filename });
		}
	}

	return { payloadJson, fileParts };
}

/** Context-owned collector used by production multipart controller graphs. */
export function createMultipartCollector(deps: MultipartCollectorDependencies): MultipartCollectorPort {
	return {
		collect: (parts, pipeline, limits) => collectWithDependencies(
			deps,
			parts,
			pipeline,
			limits,
		),
	};
}
