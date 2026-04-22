import { S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { env } from '../config/env.js';
import type { AssetKind } from '@prisma/client';

let _client: S3Client | undefined;

export function s3(): S3Client {
	if (_client) return _client;
	const e = env();
	_client = new S3Client({
		endpoint: e.S3_ENDPOINT,
		region: e.S3_REGION,
		credentials: {
			accessKeyId: e.S3_ACCESS_KEY_ID,
			secretAccessKey: e.S3_SECRET_ACCESS_KEY,
		},
		forcePathStyle: e.S3_FORCE_PATH_STYLE,
		// Without these, a Garage hiccup can hang /api/health or a game download
		// indefinitely (SDK v3 defaults to no timeout). 30s covers small ops; the
		// chunked-upload multipart path sizes its own per-chunk timeouts.
		requestHandler: new NodeHttpHandler({
			connectionTimeout: 5_000,
			requestTimeout: 30_000,
		}),
		maxAttempts: 3,
	});
	return _client;
}

export function bucketForKind(kind: AssetKind): string {
	const e = env();
	return (kind === 'GAME' || kind === 'VIDEO') ? e.S3_BUCKET_PROTECTED : e.S3_BUCKET_PUBLIC;
}
