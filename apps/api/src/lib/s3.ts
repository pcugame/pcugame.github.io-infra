import { S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';

export interface S3ClientConfig {
	/** Server-to-Garage endpoint. S3_ENDPOINT remains an input compatibility alias. */
	S3_INTERNAL_ENDPOINT?: string;
	S3_PUBLIC_SIGNING_ENDPOINT?: string;
	S3_ENDPOINT?: string;
	S3_REGION: string;
	S3_ACCESS_KEY_ID: string;
	S3_SECRET_ACCESS_KEY: string;
	S3_FORCE_PATH_STYLE: boolean;
}

function createClient(endpoint: string, config: S3ClientConfig): S3Client {
	return new S3Client({
		endpoint,
		region: config.S3_REGION,
		credentials: {
			accessKeyId: config.S3_ACCESS_KEY_ID,
			secretAccessKey: config.S3_SECRET_ACCESS_KEY,
		},
		forcePathStyle: config.S3_FORCE_PATH_STYLE,
		// AWS SDK v3 enables optional streaming CRC trailers by default. When a
		// pre-compressed WebGL object also has Content-Encoding=br/gzip, some S3-
		// compatible servers (including Garage) reject that aws-chunked trailer
		// combination. Required checksums remain enabled; optional trailers do not.
		requestChecksumCalculation: 'WHEN_REQUIRED',
		responseChecksumValidation: 'WHEN_REQUIRED',
		// Without these, a Garage hiccup can hang /api/health or a game download
		// indefinitely (SDK v3 defaults to no timeout). 30s covers small ops; the
		// chunked-upload multipart path sizes its own per-chunk timeouts.
		requestHandler: new NodeHttpHandler({
			connectionTimeout: 5_000,
			requestTimeout: 30_000,
		}),
		maxAttempts: 3,
	});
}

/** Construct the server-I/O client from explicit config without opening a socket. */
export function createS3Client(config: S3ClientConfig): S3Client {
	const endpoint = config.S3_INTERNAL_ENDPOINT ?? config.S3_ENDPOINT;
	if (!endpoint) throw new Error('S3_INTERNAL_ENDPOINT is required');
	return createClient(endpoint, config);
}

/**
 * Construct the client used only to sign browser-visible S3 requests. Do not
 * rewrite an internal presigned URL: its host/path are part of the signature.
 */
export function createS3PresigningClient(config: S3ClientConfig): S3Client {
	const endpoint = config.S3_PUBLIC_SIGNING_ENDPOINT
		?? config.S3_ENDPOINT;
	if (!endpoint) throw new Error('S3_PUBLIC_SIGNING_ENDPOINT is required');
	return createClient(endpoint, config);
}
