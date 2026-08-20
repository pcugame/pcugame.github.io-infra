import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import {
	AbortMultipartUploadCommand,
	CreateMultipartUploadCommand,
	ListPartsCommand,
	S3Client,
	UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const credentials = {
	accessKeyId: 'GK000000000000000000000001',
	secretAccessKey: '0000000000000000000000000000000000000000000000000000000000000001',
};
const common = {
	region: 'garage',
	credentials,
	forcePathStyle: true,
};
const internal = new S3Client({ ...common, endpoint: 'http://127.0.0.1:3900' });
const publicSigner = new S3Client({ ...common, endpoint: 'http://localhost:3901' });
const bucket = 'pcu-protected';
const key = `integration/api-down-put/${randomUUID()}/source.zip`;
const first = Buffer.alloc(5 * 1024 * 1024, 0x71);
const second = Buffer.alloc(1024 * 1024, 0x72);
const checksum = createHash('sha256').update(first).update(second).digest('base64');

const health = await fetch('http://127.0.0.1:4000/api/health');
if (!health.ok) throw new Error('API must be healthy before the API-down UploadPart check');

const created = await internal.send(new CreateMultipartUploadCommand({
	Bucket: bucket,
	Key: key,
	ContentType: 'application/zip',
}));
if (!created.UploadId) throw new Error('Garage did not create the multipart upload');
const uploadId = created.UploadId;

let releaseSecondChunk;
const secondChunkGate = new Promise((resolve) => { releaseSecondChunk = resolve; });
let firstChunkEmitted;
const firstChunkStarted = new Promise((resolve) => { firstChunkEmitted = resolve; });
try {
	const signedUrl = await getSignedUrl(publicSigner, new UploadPartCommand({
		Bucket: bucket,
		Key: key,
		UploadId: uploadId,
		PartNumber: 1,
		ChecksumSHA256: checksum,
	}), { expiresIn: 120 });
	const body = Readable.from((async function* browserBody() {
		yield first;
		firstChunkEmitted();
		await secondChunkGate;
		yield second;
	})());
	const put = fetch(signedUrl, {
		method: 'PUT',
		headers: {
			Origin: 'http://localhost:5173',
			'content-type': 'application/octet-stream',
		},
		body,
		duplex: 'half',
	});
	await firstChunkStarted;

	const stopped = spawnSync(
		process.platform === 'win32' ? 'docker.exe' : 'docker',
		['compose', '-f', 'docker-compose.integration.yml', 'stop', 'api'],
		{ stdio: 'inherit' },
	);
	if (stopped.status !== 0) throw new Error('Failed to stop API during direct UploadPart');
	releaseSecondChunk();
	const response = await put;
	if (response.status !== 200) {
		throw new Error(`Garage data-plane PUT failed after API shutdown (${response.status})`);
	}
	const listed = await internal.send(new ListPartsCommand({
		Bucket: bucket,
		Key: key,
		UploadId: uploadId,
	}));
	if (listed.Parts?.length !== 1 || listed.Parts[0]?.Size !== first.length + second.length) {
		throw new Error('Garage did not retain the in-flight direct part after API shutdown');
	}
	console.log(JSON.stringify({
		action: 'direct_upload_api_independence',
		result: 'healthy',
		status: response.status,
	}));
} finally {
	releaseSecondChunk?.();
	await internal.send(new AbortMultipartUploadCommand({
		Bucket: bucket,
		Key: key,
		UploadId: uploadId,
	})).catch(() => undefined);
	internal.destroy();
	publicSigner.destroy();
}
