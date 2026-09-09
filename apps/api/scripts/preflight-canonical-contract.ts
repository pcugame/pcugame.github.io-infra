/** Phase-2 contract gate: exits 0 clean, 1 blockers, 2 operational failure. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadEnv } from '../src/config/env.js';
import { createPrismaClientForDatabase } from '../src/lib/prisma-client.js';
import { createS3Client } from '../src/lib/s3.js';
import { createObjectStorage } from '../src/lib/storage.js';
import {
	CONTRACT_PREFLIGHT_RESET_CONFIRMATION,
	runContractPreflight,
	type ContractInventorySnapshot,
} from '../src/modules/migration/contract-preflight.js';
import { createContractPreflightRepository } from '../src/modules/migration/contract-preflight.prisma.js';

type CliOptions = {
	inventoryInput?: string;
	inventoryOutput?: string;
	reportOutput?: string;
	batchSize: number;
	headTimeoutMs: number;
	resetObservation: boolean;
	resetConfirmation?: string;
	observationExceptionId?: string;
	observationWindowMs?: number;
};

function option(args: readonly string[], name: string): string | undefined {
	return args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

export function parseContractPreflightCli(args: readonly string[]): CliOptions {
	const batchSize = Number(option(args, 'batch-size') ?? '20');
	const headTimeoutMs = Number(option(args, 'head-timeout-ms') ?? '5000');
	if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error('batch-size must be between 1 and 100');
	if (!Number.isInteger(headTimeoutMs) || headTimeoutMs < 100 || headTimeoutMs > 60_000) throw new Error('head-timeout-ms must be between 100 and 60000');
	const known = new Set(['--reset-observation']);
	for (const arg of args) {
		if (known.has(arg) || ['inventory-input', 'inventory-output', 'report-output', 'batch-size', 'head-timeout-ms', 'confirm-reset', 'observation-exception-id'].some((name) => arg.startsWith(`--${name}=`))) continue;
		throw new Error(`Unknown preflight option: ${arg}`);
	}
	const resetObservation = args.includes('--reset-observation');
	const resetConfirmation = option(args, 'confirm-reset');
	if (resetObservation && resetConfirmation !== CONTRACT_PREFLIGHT_RESET_CONFIRMATION) {
		throw new Error(`--reset-observation requires --confirm-reset=${CONTRACT_PREFLIGHT_RESET_CONFIRMATION}`);
	}
	const observationExceptionId = option(args, 'observation-exception-id');
	if (observationExceptionId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(observationExceptionId)) {
		throw new Error('observation-exception-id must contain 8-128 safe identifier characters');
	}
	if (observationExceptionId && resetObservation) throw new Error('observation exception must not reset metrics');
	return {
		...(observationExceptionId ? { observationExceptionId, observationWindowMs: 0 } : {}),
		...(option(args, 'inventory-input') ? { inventoryInput: resolve(option(args, 'inventory-input')!) } : {}),
		...(option(args, 'inventory-output') ? { inventoryOutput: resolve(option(args, 'inventory-output')!) } : {}),
		...(option(args, 'report-output') ? { reportOutput: resolve(option(args, 'report-output')!) } : {}),
		batchSize, headTimeoutMs, resetObservation, resetConfirmation,
	};
}

function parseInventory(value: unknown): ContractInventorySnapshot {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('inventory snapshot must be an object');
	const snapshot = value as Partial<ContractInventorySnapshot>;
	if (typeof snapshot.identity !== 'string' || typeof snapshot.capturedAt !== 'string' || !Array.isArray(snapshot.objects)) {
		throw new Error('inventory snapshot has an invalid shape');
	}
	if (!snapshot.objects.every((object) => object && typeof object.bucket === 'string' && typeof object.key === 'string')) {
		throw new Error('inventory snapshot contains an invalid object');
	}
	const multipartUploads = snapshot.multipartUploads ?? [];
	if (!Array.isArray(multipartUploads) || !multipartUploads.every((upload) => upload
		&& typeof upload.bucket === 'string' && typeof upload.key === 'string' && typeof upload.uploadId === 'string')) {
		throw new Error('inventory snapshot contains an invalid multipart upload');
	}
	return { ...snapshot, multipartUploads } as ContractInventorySnapshot;
}

async function atomicJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
	await rename(temporary, path);
}

async function main(): Promise<number> {
	const options = parseContractPreflightCli(process.argv.slice(2));
	const config = loadEnv();
	const prisma = createPrismaClientForDatabase(config.DATABASE_URL);
	const s3 = createS3Client(config);
	const storage = createObjectStorage(s3, { defaultPresignTtlSec: config.S3_PRESIGN_TTL_SEC });
	try {
		const listed = options.inventoryInput ? null : await Promise.all([
			storage.listKeys(config.S3_BUCKET_PROTECTED, ''),
			storage.listKeys(config.S3_BUCKET_PUBLIC, ''),
			storage.listMultipartUploads(config.S3_BUCKET_PROTECTED, ''),
			storage.listMultipartUploads(config.S3_BUCKET_PUBLIC, ''),
		]);
		const inventory = options.inventoryInput
			? parseInventory(JSON.parse(await readFile(options.inventoryInput, 'utf8')))
			: {
				identity: `garage-list:${new Date().toISOString()}`,
				capturedAt: new Date().toISOString(),
				objects: [
					...(listed?.[0] ?? []).map((key) => ({ bucket: config.S3_BUCKET_PROTECTED, key })),
					...(listed?.[1] ?? []).map((key) => ({ bucket: config.S3_BUCKET_PUBLIC, key })),
				],
				multipartUploads: [
					...(listed?.[2] ?? []).map((upload) => ({ bucket: config.S3_BUCKET_PROTECTED, key: upload.key, uploadId: upload.uploadId })),
					...(listed?.[3] ?? []).map((upload) => ({ bucket: config.S3_BUCKET_PUBLIC, key: upload.key, uploadId: upload.uploadId })),
				],
			};
		if (options.inventoryOutput) await atomicJson(options.inventoryOutput, inventory);
		const report = await runContractPreflight({
			repository: createContractPreflightRepository(prisma),
			inventory,
			head: async (bucket, key, signal) => {
				const metadata = await storage.head(bucket, key, { signal });
				if (!metadata) return null;
				if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) {
					throw new Error(`Garage HEAD returned unsafe size for ${bucket}/${key}`);
				}
				return {
					sizeBytes: BigInt(metadata.size),
					mimeType: metadata.contentType,
					etag: metadata.etag ?? null,
					checksumSha256: metadata.checksumSha256 ?? null,
				};
			},
			options: {
				...options,
				protectedBucket: config.S3_BUCKET_PROTECTED,
				publicBucket: config.S3_BUCKET_PUBLIC,
			},
		});
		if (options.reportOutput) await atomicJson(options.reportOutput, report);
		console.log(JSON.stringify(report, null, 2));
		return report.clean ? 0 : 1;
	} catch (error) {
		console.error(JSON.stringify({ event: 'canonical_contract_preflight_operational_failure', message: error instanceof Error ? error.message : String(error) }));
		return 2;
	} finally {
		s3.destroy();
		await prisma.$disconnect();
	}
}

const executedPath = process.argv[1];
if (executedPath && import.meta.url === pathToFileURL(executedPath).href) {
	void main().then((code) => { process.exitCode = code; });
}
