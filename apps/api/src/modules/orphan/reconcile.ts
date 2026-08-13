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
}

export function parseReconcileOptions(
	argv: readonly string[],
	startedAt = new Date(),
): ReconcileOptions {
	const apply = argv.includes('--apply');
	const ageArgument = argv.find((argument) => argument.startsWith('--older-than-minutes='));
	const olderThanMinutes = ageArgument
		? Number(ageArgument.slice('--older-than-minutes='.length))
		: 60;
	if (!Number.isFinite(olderThanMinutes) || olderThanMinutes < 0) {
		throw new Error('--older-than-minutes must be a non-negative number');
	}
	return { apply, olderThanMinutes, startedAt };
}

async function listAllObjects(storage: ObjectStorage, bucket: string): Promise<StoredObject[]> {
	if (storage.listObjects) return storage.listObjects(bucket, '');
	// Older adapters expose keys only. Unknown LastModified is intentionally not
	// synthesized: the age fence must fail closed.
	return (await storage.listKeys(bucket, '')).map((key) => ({ key }));
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
	const orphanRepository = createOrphanRepository(input.prisma);
	const inventory = await collectObjectReferences(
		input.prisma,
		{
			publicBucket: input.publicBucket,
			protectedBucket: input.protectedBucket,
		},
		{ error: (context, message) => logger.error(message, context) },
	);
	const referenceIndex = createObjectReferenceIndex(inventory);
	const fence = new Date(
		input.options.startedAt.getTime() - input.options.olderThanMinutes * 60 * 1000,
	);

	let scanned = 0;
	let eligible = 0;
	let enqueued = 0;
	let skippedUnknownAge = 0;
	for (const bucket of new Set([input.publicBucket, input.protectedBucket])) {
		const objects = await listAllObjects(input.storage, bucket);
		scanned += objects.length;
		const candidates: StoredObject[] = [];
		for (const object of objects) {
			if (!object.lastModified) {
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
