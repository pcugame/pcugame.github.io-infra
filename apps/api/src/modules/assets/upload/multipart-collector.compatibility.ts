import { createWriteStream, promises as fileSystem } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { MultipartPart } from '../../../application/http-input.js';
import type {
	MultipartCollectorPort,
	UploadPipelinePort,
} from '../../../application/upload-ports.js';
import type { UploadLimits } from '../../../shared/upload-policy.js';
import { createMultipartCollector } from './multipart-collector.js';

const compatibilityCollector: MultipartCollectorPort = createMultipartCollector({
	fileSystem: {
		temporaryDirectory: () => os.tmpdir(),
		createWriteStream,
		stat: async (path) => fileSystem.stat(path),
	},
	ids: { next: randomUUID },
});

/** Compatibility only; production ticket-011 routes do not import this module. */
export function collectMultipartParts(
	parts: AsyncIterable<MultipartPart>,
	pipeline: UploadPipelinePort,
	limits: UploadLimits,
) {
	return compatibilityCollector.collect(parts, pipeline, limits);
}
