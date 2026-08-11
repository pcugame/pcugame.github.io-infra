import { createPrismaClientForDatabase } from '../../lib/prisma-client.js';
import { createS3Client } from '../../lib/s3.js';
import { createObjectStorage } from '../../lib/storage.js';
import { commitUploadIntents } from '../../modules/upload-intent/repository.js';

type FaultStage =
	| 'after-intent-before-put'
	| 'after-put-before-commit'
	| 'during-reference-commit'
	| 'after-commit-before-response';

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function checkpoint(stage: FaultStage): Promise<never> {
	if (!process.send) throw new Error('Crash fixture requires an IPC channel');
	process.send({ type: 'checkpoint', stage });
	return new Promise(() => undefined);
}

const stage = required('FAULT_STAGE') as FaultStage;
const intentId = required('FAULT_INTENT_ID');
const storageKey = required('FAULT_STORAGE_KEY');
const bucket = required('FAULT_BUCKET');
const projectId = Number(required('FAULT_PROJECT_ID'));
if (!Number.isSafeInteger(projectId) || projectId <= 0) {
	throw new Error('FAULT_PROJECT_ID must be a positive integer');
}

const prisma = createPrismaClientForDatabase(required('DATABASE_URL'));
const s3 = createS3Client({
	S3_ENDPOINT: required('S3_ENDPOINT'),
	S3_REGION: required('S3_REGION'),
	S3_ACCESS_KEY_ID: required('S3_ACCESS_KEY_ID'),
	S3_SECRET_ACCESS_KEY: required('S3_SECRET_ACCESS_KEY'),
	S3_FORCE_PATH_STYLE: true,
});
const storage = createObjectStorage(s3, { defaultPresignTtlSec: 60 });

await prisma.$connect();
await prisma.uploadIntent.create({
	data: {
		id: intentId,
		bucket,
		storageKey,
		purpose: `fault-fixture:${stage}`,
		ownerProjectId: projectId,
		notBefore: new Date(0),
	},
});

if (stage === 'after-intent-before-put') await checkpoint(stage);

const body = Buffer.from(`durable upload intent crash fixture: ${stage}`);
await storage.upload(bucket, storageKey, body, 'application/octet-stream', body.length);
await prisma.uploadIntent.update({
	where: { id: intentId },
	data: { state: 'UPLOADED' },
});

if (stage === 'after-put-before-commit') await checkpoint(stage);

const assetData = {
	projectId,
	kind: 'IMAGE' as const,
	storageKey,
	originalName: `${stage}.bin`,
	mimeType: 'application/octet-stream',
	sizeBytes: BigInt(body.length),
	isPublic: true,
};

if (stage === 'during-reference-commit') {
	await prisma.$transaction(async (tx) => {
		await tx.asset.create({ data: assetData });
		await checkpoint(stage);
	});
}

await prisma.$transaction(async (tx) => {
	await tx.asset.create({ data: assetData });
	await commitUploadIntents(tx, [intentId]);
});
await checkpoint('after-commit-before-response');
