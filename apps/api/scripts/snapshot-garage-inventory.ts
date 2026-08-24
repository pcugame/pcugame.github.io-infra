/** Capture the pre-cutover Garage object/multipart inventory without DB writes. */
import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadEnv } from '../src/config/env.js';
import { createS3Client } from '../src/lib/s3.js';
import { createObjectStorage } from '../src/lib/storage.js';

function outputPath(args: readonly string[]): string {
	if (args.length !== 1 || !args[0]?.startsWith('--output=')) {
		throw new Error('usage: snapshot-garage-inventory --output=/absolute/path/inventory.json');
	}
	return resolve(args[0].slice('--output='.length));
}

async function atomicJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
	await rename(temporary, path);
}

async function main(): Promise<void> {
	const target = outputPath(process.argv.slice(2));
	const config = loadEnv();
	const s3 = createS3Client(config);
	const storage = createObjectStorage(s3, { defaultPresignTtlSec: config.S3_PRESIGN_TTL_SEC });
	try {
		const [protectedObjects, publicObjects, protectedUploads, publicUploads] = await Promise.all([
			storage.listKeys(config.S3_BUCKET_PROTECTED, ''),
			storage.listKeys(config.S3_BUCKET_PUBLIC, ''),
			storage.listMultipartUploads(config.S3_BUCKET_PROTECTED, ''),
			storage.listMultipartUploads(config.S3_BUCKET_PUBLIC, ''),
		]);
		const capturedAt = new Date().toISOString();
		const inventory = {
			identity: `garage-release-snapshot:${capturedAt}:${randomUUID()}`,
			capturedAt,
			objects: [
				...protectedObjects.map((key) => ({ bucket: config.S3_BUCKET_PROTECTED, key })),
				...publicObjects.map((key) => ({ bucket: config.S3_BUCKET_PUBLIC, key })),
			],
			multipartUploads: [
				...protectedUploads.map((upload) => ({ bucket: config.S3_BUCKET_PROTECTED, key: upload.key, uploadId: upload.uploadId })),
				...publicUploads.map((upload) => ({ bucket: config.S3_BUCKET_PUBLIC, key: upload.key, uploadId: upload.uploadId })),
			],
		};
		await atomicJson(target, inventory);
		console.log(JSON.stringify({ event: 'garage_inventory_snapshot_written', target, objectCount: inventory.objects.length, multipartCount: inventory.multipartUploads.length }));
	} finally {
		s3.destroy();
	}
}

void main().catch((error) => {
	console.error(JSON.stringify({ event: 'garage_inventory_snapshot_failed', message: error instanceof Error ? error.message : String(error) }));
	process.exitCode = 1;
});
