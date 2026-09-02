import type { ObjectStorage, StoredObject } from '../../application/ports.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { createOrphanRepository } from './repository.js';
import {
	collectObjectReferences,
	createObjectReferenceIndex,
} from './reference-resolver.js';

export interface ReconcileOptions {
	apply: boolean;
	olderThanMinutes: number;
	startedAt: Date;
	exactTargets?: ExactReconcileTarget[];
}

export interface ExactReconcileTarget {
	bucket: string;
	key: string;
}

export function parseReconcileOptions(
	argv: readonly string[],
	startedAt = new Date(),
): ReconcileOptions {
	const apply = argv.includes('--apply');
	const exactTargets: ExactReconcileTarget[] = [];
	const exactTargetIdentities = new Set<string>();
	for (const argument of argv) {
		if (argument === '--exact-target' || argument.startsWith('--exact-target=')) {
			if (!argument.startsWith('--exact-target=')) {
				throw new Error('--exact-target must have the form <bucket>:<object-key>');
			}
			const value = argument.slice('--exact-target='.length);
			const separator = value.indexOf(':');
			const bucket = separator < 0 ? '' : value.slice(0, separator);
			const key = separator < 0 ? '' : value.slice(separator + 1);
			if (!bucket || !key) {
				throw new Error('--exact-target must have the form <bucket>:<object-key>');
			}
			const identity = `${bucket}\0${key}`;
			if (exactTargetIdentities.has(identity)) {
				throw new Error(`Duplicate --exact-target: ${bucket}:${key}`);
			}
			exactTargetIdentities.add(identity);
			exactTargets.push({ bucket, key });
		}
	}
	const ageArgument = argv.find((argument) => argument.startsWith('--older-than-minutes='));
	const ageValue = ageArgument?.slice('--older-than-minutes='.length);
	if (ageValue !== undefined && ageValue.trim().length === 0) {
		throw new Error('--older-than-minutes must be a non-negative number');
	}
	const olderThanMinutes = ageArgument
		? Number(ageValue)
		: 60;
	if (!Number.isFinite(olderThanMinutes) || olderThanMinutes < 0) {
		throw new Error('--older-than-minutes must be a non-negative number');
	}
	return {
		apply,
		olderThanMinutes,
		startedAt,
		...(exactTargets.length > 0 ? { exactTargets } : {}),
	};
}

async function listAllObjects(storage: ObjectStorage, bucket: string): Promise<StoredObject[]> {
	if (storage.listObjects) return storage.listObjects(bucket, '');
	// Older adapters expose keys only. Unknown LastModified is intentionally not
	// synthesized: the age fence must fail closed.
	return (await storage.listKeys(bucket, '')).map((key) => ({ key }));
}

function createAgeFence(options: ReconcileOptions): Date {
	const fence = new Date(
		options.startedAt.getTime() - options.olderThanMinutes * 60 * 1000,
	);
	if (Number.isNaN(fence.getTime())) {
		throw new Error('--older-than-minutes produces an invalid age fence');
	}
	return fence;
}

export async function reconcileObjects(input: {
	prisma: PrismaClient;
	storage: ObjectStorage;
	publicBucket: string;
	protectedBucket: string;
	options: ReconcileOptions;
	logger?: Pick<Console, 'log' | 'error'>;
}): Promise<{ scanned: number; eligible: number; enqueued: number; skippedUnknownAge: number }> {
	const logger = input.logger ?? console;
	const fence = createAgeFence(input.options);
	const orphanRepository = createOrphanRepository(input.prisma);
	const exactTargets = input.options.exactTargets ?? [];
	if (exactTargets.length > 0) {
		const configuredBuckets = new Set([input.publicBucket, input.protectedBucket]);
		for (const target of exactTargets) {
			if (!configuredBuckets.has(target.bucket)) {
				throw new Error(`--exact-target bucket is not configured: ${target.bucket}`);
			}
		}
	}
	const inventory = await collectObjectReferences(
		input.prisma,
		{
			publicBucket: input.publicBucket,
			protectedBucket: input.protectedBucket,
		},
		{ error: (context, message) => logger.error(message, context) },
	);
	const referenceIndex = createObjectReferenceIndex(inventory);
	if (exactTargets.length > 0) {
		return reconcileExactTargets({
			...input,
			logger,
			referenceIndex,
			orphanRepository,
			fence,
		});
	}

	let scanned = 0;
	let eligible = 0;
	let enqueued = 0;
	let skippedUnknownAge = 0;
	for (const bucket of new Set([input.publicBucket, input.protectedBucket])) {
		const objects = await listAllObjects(input.storage, bucket);
		scanned += objects.length;
		const candidates: StoredObject[] = [];
		for (const object of objects) {
			if (!object.lastModified || Number.isNaN(object.lastModified.getTime())) {
				skippedUnknownAge++;
				continue;
			}
			if (object.lastModified > fence || object.lastModified > input.options.startedAt) continue;
			if (referenceIndex.referencesTarget({
				bucket,
				targetKind: 'EXACT',
				key: object.key,
			})) continue;
			candidates.push(object);
		}
		eligible += candidates.length;
		logger.log(
			`[${bucket}] total=${objects.length} eligible=${candidates.length}`
			+ (input.options.apply ? ' mode=apply' : ' mode=dry-run'),
		);

		if (!input.options.apply) {
			for (const object of candidates.slice(0, 20)) logger.log(`  would enqueue: ${object.key}`);
			if (candidates.length > 20) logger.log(`  …and ${candidates.length - 20} more`);
			continue;
		}
		for (const object of candidates) {
			await orphanRepository.upsertOrphan(
				bucket,
				object.key,
				'reconcile',
				'EXACT',
				input.options.startedAt,
			);
			enqueued++;
		}
	}
	return { scanned, eligible, enqueued, skippedUnknownAge };
}

async function reconcileExactTargets(input: {
	prisma: PrismaClient;
	storage: ObjectStorage;
	publicBucket: string;
	protectedBucket: string;
	options: ReconcileOptions;
	logger: Pick<Console, 'log' | 'error'>;
	referenceIndex: ReturnType<typeof createObjectReferenceIndex>;
	orphanRepository: ReturnType<typeof createOrphanRepository>;
	fence: Date;
}): Promise<{ scanned: number; eligible: number; enqueued: number; skippedUnknownAge: number }> {
	let eligible = 0;
	let enqueued = 0;
	let skippedUnknownAge = 0;
	const exactTargets = input.options.exactTargets ?? [];
	for (const target of exactTargets) {
		// Exact mode deliberately establishes the current object state with one
		// HEAD per supplied target; it must not expand a target into bucket LIST.
		const object = await input.storage.head(target.bucket, target.key);
		const existing = await input.prisma.orphanObject.findUnique({
			where: {
				orphan_bucket_storage_key: { bucket: target.bucket, storageKey: target.key },
			},
		});
		if (existing?.state !== 'CANCELLED'
			|| existing.cancelReason !== 'live-reference-detected'
			|| existing.targetKind !== 'EXACT') {
			input.logger.log(`[${target.bucket}] exact ${target.key} skipped=not-cancelled-live-reference-outbox`);
			continue;
		}

		if (input.referenceIndex.referencesTarget({
			bucket: target.bucket,
			targetKind: 'EXACT',
			key: target.key,
		})) {
			input.logger.log(`[${target.bucket}] exact ${target.key} skipped=live-reference-detected`);
			continue;
		}
		if (object && (!object.lastModified || Number.isNaN(object.lastModified.getTime()))) {
			skippedUnknownAge++;
			input.logger.log(`[${target.bucket}] exact ${target.key} skipped=unknown-age`);
			continue;
		}
		if (object?.lastModified && (object.lastModified > input.fence
			|| object.lastModified > input.options.startedAt)) {
			input.logger.log(`[${target.bucket}] exact ${target.key} skipped=recent`);
			continue;
		}

		const decision = object ? 'would-rearm' : 'would-rearm-absent';
		if (!input.options.apply) {
			eligible++;
			input.logger.log(`[${target.bucket}] exact ${target.key} ${decision}`);
			continue;
		}
		const rearm = await input.orphanRepository.upsertOrphan(
			target.bucket,
			target.key,
			'reconcile',
			'EXACT',
			input.options.startedAt,
			{ requireCancelledLiveReference: true },
		);
		if (!('rearmed' in rearm) || !rearm.rearmed) {
			input.logger.log(`[${target.bucket}] exact ${target.key} skipped=outbox-state-changed`);
			continue;
		}
		eligible++;
		enqueued++;
		input.logger.log(`[${target.bucket}] exact ${target.key} rearmed${object ? '' : '-absent'}`);
	}

	return {
		scanned: exactTargets.length,
		eligible,
		enqueued,
		skippedUnknownAge,
	};
}
