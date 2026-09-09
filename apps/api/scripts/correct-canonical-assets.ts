/** Phase 1 correction release operation. No command changes asset rows except apply. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv } from '../src/config/env.js';
import { createPrismaClientForDatabase } from '../src/lib/prisma-client.js';
import { createS3Client } from '../src/lib/s3.js';
import { createCanonicalCorrectionObjectStore } from '../src/infrastructure/canonical-correction.s3.js';
import { applyCorrection, correctionManifestHash, investigateCorrection, prepareCorrection, validatePreparedCorrection } from '../src/modules/migration/canonical-correction.js';
import { assertCorrectionSnapshot, createCanonicalCorrectionRepository } from '../src/modules/migration/canonical-correction.prisma.js';
import type { CorrectionCandidate, CorrectionManifest } from '../src/modules/migration/canonical-correction.types.js';

export async function atomicCorrectionJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, path);
}
function required(args: string[], name: string): string {
	const value = args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
	if (!value) throw new Error(`Missing --${name}=VALUE`);
	return value;
}
async function verifyEvidence(items: CorrectionCandidate[], base: string): Promise<void> {
	for (const item of items) if (item.ownershipEvidence) {
		const bytes = await readFile(resolve(base, item.ownershipEvidence.artifact));
		if (createHash('sha256').update(bytes).digest('hex') !== item.ownershipEvidence.sha256) throw new Error('Ownership evidence artifact hash changed');
	}
}
async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes('--help')) {
		console.log(`correct-canonical-assets investigate --candidates=PATH --manifest=PATH
correct-canonical-assets prepare --manifest=PATH
correct-canonical-assets protect --manifest=PATH
correct-canonical-assets apply --manifest=PATH --expected-hash=SHA256 --writes-drained --receipt=PATH

investigate verifies source bytes and captures complete ownership/order/reference snapshots.
prepare reserves new IDs and checkpoints protected copies/outputs; rerun the same file after interruption.
protect renews all output cleanup grace periods while awaiting reviewed-manifest approval.
apply requires the hash printed by prepare and a writes-drained operator assertion. Its manifest remains immutable.
Run poster preparation in a container with --memory=2g, with ffmpeg/ffprobe installed.
Ownership evidence paths are relative to the candidates/manifest directory; preserve evidence with the manifest.`);
		return;
	}
	const phase = args[0];
	if (!['investigate', 'prepare', 'protect', 'apply'].includes(phase ?? '')) throw new Error('Expected investigate, prepare, protect or apply');
	const path = resolve(required(args, 'manifest'));
	const config = loadEnv();
	const prisma = createPrismaClientForDatabase(config.DATABASE_URL);
	const s3 = createS3Client(config);
	try {
		const repository = createCanonicalCorrectionRepository(prisma);
		const objects = createCanonicalCorrectionObjectStore(s3, { tempRoot: config.IMAGE_WORKER_TEMP_ROOT });
		let manifest: CorrectionManifest;
		if (phase === 'investigate') {
			try { await readFile(path); throw new Error('Investigation refuses to overwrite an existing manifest; use a new path'); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
			const candidatesPath = resolve(required(args, 'candidates'));
			const candidates = JSON.parse(await readFile(candidatesPath, 'utf8')) as CorrectionCandidate[];
			await verifyEvidence(candidates, dirname(candidatesPath));
			manifest = await investigateCorrection({ candidates, repository, objects, protectedBucket: config.S3_BUCKET_PROTECTED, publicBucket: config.S3_BUCKET_PUBLIC });
			assertCorrectionSnapshot(manifest, manifest.snapshots);
			await atomicCorrectionJson(path, manifest);
		} else {
			manifest = JSON.parse(await readFile(path, 'utf8')) as CorrectionManifest;
			if (manifest.protectedBucket !== config.S3_BUCKET_PROTECTED || manifest.publicBucket !== config.S3_BUCKET_PUBLIC) throw new Error('Manifest belongs to another storage environment');
			await verifyEvidence(manifest.items, dirname(path));
			if (phase === 'prepare') {
				assertCorrectionSnapshot(manifest, await repository.snapshot([...new Set(manifest.items.map((i) => i.projectId))], manifest.items.map((i) => i.source.key)));
				manifest = await prepareCorrection({ manifest, repository, objects, save: (next) => atomicCorrectionJson(path, next) });
			} else if (phase === 'protect') {
				if (!['PREPARING', 'PREPARED'].includes(manifest.phase)) throw new Error('Only staged outputs can be protected');
				for (const item of manifest.items) for (const output of item.outputs) await repository.protect(item, output);
			} else {
				if (!args.includes('--writes-drained')) throw new Error('Apply requires a completed write drain and --writes-drained');
				const receiptPath = resolve(required(args, 'receipt'));
				if (receiptPath === path) throw new Error('Receipt must not overwrite the reviewed manifest');
				validatePreparedCorrection(manifest);
				const result = await applyCorrection({ manifest, expectedHash: required(args, 'expected-hash'), repository, objects });
				await atomicCorrectionJson(receiptPath, { version: 1, manifestId: manifest.id, manifestHash: correctionManifestHash(manifest),
					result, committedAt: new Date().toISOString(), assets: manifest.items.map((i) => i.assetId ?? i.reservedAssetId) });
			}
		}
		console.log(JSON.stringify({ phase, manifest: path, manifestId: manifest.id, manifestHash: correctionManifestHash(manifest), items: manifest.items.length, state: manifest.phase }));
	} finally { s3.destroy(); await prisma.$disconnect(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch((error) => { console.error('correct-canonical-assets failed:', error); process.exitCode = 1; });
