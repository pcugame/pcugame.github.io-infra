import type { AppLogger, ObjectStorage } from '../../application/ports.js';
import type { ProjectPublicationRepository } from './ports.js';
import { createProjectPublicationWorker } from './worker.js';

export function createProjectPublicationGraph(input: {
	repository: ProjectPublicationRepository;
	storage: Pick<ObjectStorage, 'head' | 'stream' | 'upload' | 'delete'>;
	ids: { next(): string };
	logger: Pick<AppLogger, 'error' | 'warn'>;
}) {
	return createProjectPublicationWorker({
		repository: input.repository,
		ids: input.ids,
		logger: input.logger,
		storage: {
			async head(bucket, key, signal) {
				const head = await input.storage.head(bucket, key, signal ? { signal } : undefined);
				return head ? { size: head.size, ...(head.checksumSha256 ? { checksumSha256: head.checksumSha256 } : {}) } : null;
			},
			async stream(bucket, key, signal) {
				const object = await input.storage.stream(bucket, key, undefined, signal ? { signal } : undefined);
				if (!object || 'kind' in object) throw new Error('Publication staging source is missing');
				return { body: object.body, size: object.size };
			},
			async upload(object) {
				await input.storage.upload(object.bucket, object.key, object.body, object.contentType, object.contentLength, {
					contentType: object.contentType,
					...(object.contentEncoding ? { contentEncoding: object.contentEncoding } : {}),
					cacheControl: object.cacheControl,
					checksumSha256: object.checksumSha256,
				}, object.signal ? { signal: object.signal } : undefined);
			},
			delete: (bucket, key, signal) => input.storage.delete(bucket, key, signal ? { signal } : undefined),
		},
	});
}
