import { createS3Client as buildStorageClient } from '../../../src/lib/s3.js';

export const harmlessLookingAdapter = buildStorageClient({});
