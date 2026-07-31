import { createS3Client as buildStorageClient } from '../src/lib/s3.js';

export function createStorageAdapter(config: Parameters<typeof buildStorageClient>[0]) {
	return buildStorageClient(config);
}
