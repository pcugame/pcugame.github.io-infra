import { createHash } from 'node:crypto';
import { createCanonicalWebglPublicKeys, parseWebglEntryKey } from '../webgl/paths.js';
import type {
	CanonicalApplyOutcome,
	CanonicalAssetPlan,
	CanonicalBackfillFailure,
	CanonicalBackfillMode,
	CanonicalBackfillOptions,
	CanonicalBackfillProgress,
	CanonicalBackfillRepository,
	CanonicalBackfillResult,
	CanonicalBackfillStats,
	CanonicalExhibitionPlan,
	CanonicalFailureCode,
	CanonicalObjectHeadVerifier,
	CanonicalObjectMaterializer,
	CanonicalObjectCopy,
	CanonicalObjectRelocation,
	CanonicalRepresentationPlan,
	CanonicalWebglPlan,
	CanonicalWorkRef,
	LegacyAssetRow,
	LegacyExhibitionRow,
	LegacyWebglRow,
	ObjectHeadRecord,
} from './canonical-backfill.types.js';

const IMAGE_KINDS = new Set(['THUMBNAIL', 'IMAGE', 'POSTER']);
const BROWSER_PLAYABLE_VIDEO_MIMES = new Set(['video/mp4', 'video/webm', 'video/ogg']);
const PHASES = ['assets', 'exhibitions', 'webgl'] as const;
const WEBGL_MANIFEST_PAGE_SIZE = 500;
const MAX_WEBGL_MANIFEST_OBJECTS = 10_000;
const SAFE_EXTENSION_BY_MIME = new Map([
	['application/zip', 'zip'],
	['application/x-zip-compressed', 'zip'],
	['application/pdf', 'pdf'],
	['image/jpeg', 'jpg'],
	['image/png', 'png'],
	['image/webp', 'webp'],
	['video/mp4', 'mp4'],
	['video/quicktime', 'mov'],
	['video/webm', 'webm'],
	['video/ogg', 'ogv'],
]);

class CanonicalPlanError extends Error {
	constructor(
		readonly code: CanonicalFailureCode,
		message: string,
	) {
		super(message);
		this.name = 'CanonicalPlanError';
	}
}

function normalizedMime(mimeType: string): string {
	return mimeType.split(';', 1)[0]!.trim().toLowerCase();
}

function assertLegacyKey(key: string, label: string): void {
	if (!key || key.includes('\0') || key.startsWith('/') || key.split('/').includes('..')) {
		throw new CanonicalPlanError('MALFORMED_LEGACY_ROW', `${label} has an unsafe object key`);
	}
}

function assertPositiveSize(size: bigint, label: string): void {
	if (size <= 0n) {
		throw new CanonicalPlanError('MALFORMED_LEGACY_ROW', `${label} has a non-positive size`);
	}
}

function renditionKey(sourceKey: string, profile: 'card-480' | 'display-960'): string {
	return `${sourceKey}/__pcu_image_rendition__/v1/${profile}.webp`;
}

function representationFromHead(
	role: CanonicalRepresentationPlan['role'],
	bucket: string,
	objectKey: string,
	head: ObjectHeadRecord,
	dimensions: { width: number | null; height: number | null },
): CanonicalRepresentationPlan {
	const checksum = head.checksumSha256?.toLowerCase() ?? null;
	const sourceIdentity = checksum ?? (head.etag ? `${head.etag}:${head.size}` : null);
	return {
		role,
		bucket,
		objectKey,
		mimeType: head.mimeType,
		sizeBytes: head.size,
		checksumAlgorithm: checksum ? 'SHA256' : null,
		checksum,
		etag: head.etag ?? null,
		sourceIdentityAlgorithm: checksum ? 'SHA256' : (sourceIdentity ? 'S3_ETAG_SIZE' : null),
		sourceIdentity,
		width: dimensions.width,
		height: dimensions.height,
	};
}

function stableGeneration(representation: CanonicalRepresentationPlan): string {
	if (!representation.sourceIdentityAlgorithm || !representation.sourceIdentity) {
		throw new CanonicalPlanError(
			'SOURCE_NOT_PROVEN',
			`${representation.role} source lacks immutable checksum/ETag provenance`,
		);
	}
	return createHash('sha256')
		.update(representation.sourceIdentityAlgorithm)
		.update('\0')
		.update(representation.sourceIdentity)
		.digest('hex')
		.slice(0, 32);
}

function safeExtension(mimeType: string): string {
	const extension = SAFE_EXTENSION_BY_MIME.get(normalizedMime(mimeType));
	if (!extension) {
		throw new CanonicalPlanError('MALFORMED_LEGACY_ROW', `unsupported canonical object MIME: ${mimeType}`);
	}
	return extension;
}

function representationDestination(input: {
	ownerPrefix: string;
	bucket: string;
	representation: CanonicalRepresentationPlan;
}): string {
	return `${input.ownerPrefix}/${input.representation.role.toLowerCase()}/${stableGeneration(input.representation)}.${safeExtension(input.representation.mimeType)}`;
}

function objectCopyForRepresentation(
	representation: CanonicalRepresentationPlan,
	destinationBucket: string,
	destinationKey: string,
): CanonicalObjectCopy {
	return {
		sourceBucket: representation.bucket,
		sourceKey: representation.objectKey,
		destinationBucket,
		destinationKey,
		expected: {
			size: representation.sizeBytes,
			mimeType: representation.mimeType,
			...(representation.etag ? { etag: representation.etag } : {}),
			...(representation.checksumAlgorithm?.toUpperCase() === 'SHA256' && representation.checksum
				? { checksumSha256: representation.checksum }
				: {}),
		},
	};
}

async function materializeRepresentationNamespace(input: {
	representations: CanonicalRepresentationPlan[];
	destinationBucket: string;
	ownerPrefix: string;
	materializer: CanonicalObjectMaterializer;
	repository: CanonicalBackfillRepository;
	workKind: 'asset' | 'exhibition';
	workRef: string;
}): Promise<{ representations: CanonicalRepresentationPlan[]; created: number; reused: number; relocations: CanonicalObjectRelocation[] }> {
	let created = 0;
	let reused = 0;
	const relocations: CanonicalObjectRelocation[] = [];
	const representations: CanonicalRepresentationPlan[] = [];
	for (const source of input.representations) {
		const rolePrefix = `${input.ownerPrefix}/${source.role.toLowerCase()}/`;
		if (source.bucket === input.destinationBucket && source.objectKey.startsWith(rolePrefix)) {
			representations.push(source);
			continue;
		}
		const destinationKey = representationDestination({
			ownerPrefix: input.ownerPrefix,
			bucket: input.destinationBucket,
			representation: source,
		});
		const copy = objectCopyForRepresentation(source, input.destinationBucket, destinationKey);
		const prepared = {
			workKind: input.workKind,
			workRef: input.workRef,
			role: source.role,
			copy,
		};
		await input.repository.prepareObjectRelocation(prepared);
		const outcome = await input.materializer.ensureCanonicalObjectCopy(copy, {
			beforeCreate: (target) => input.repository.prepareMaterializationCleanup(target),
		});
		const relocation = { ...prepared, verified: outcome.head };
		await input.repository.markObjectRelocationMaterialized(relocation);
		created += Number(outcome.created);
		reused += Number(!outcome.created);
		relocations.push(relocation);
		const canonical = representationFromHead(
			source.role,
			input.destinationBucket,
			destinationKey,
			outcome.head,
			{ width: source.width, height: source.height },
		);
		canonical.sourceIdentityAlgorithm = 'MIGRATION_COPY_SHA256';
		canonical.sourceIdentity = outcome.head.checksumSha256 ?? canonical.sourceIdentity;
		representations.push(canonical);
	}
	return { representations, created, reused, relocations };
}

function expectedBucketForAsset(row: LegacyAssetRow, buckets: CanonicalBuckets): string {
	const shouldBePublic = IMAGE_KINDS.has(row.kind);
	if (row.isPublic !== shouldBePublic) {
		throw new CanonicalPlanError(
			'MALFORMED_LEGACY_ROW',
			`asset ${row.id} has an authorization bucket policy mismatch`,
		);
	}
	return shouldBePublic ? buckets.publicBucket : buckets.protectedBucket;
}

interface CanonicalBuckets {
	protectedBucket: string;
	publicBucket: string;
}

function createVerifiedHead(
	verifier: CanonicalObjectHeadVerifier,
	buckets: CanonicalBuckets,
): (
		expectedBucket: string,
		key: string,
		expected?: { size?: bigint; mimeType?: string },
	) => Promise<ObjectHeadRecord> {
	if (!buckets.protectedBucket || !buckets.publicBucket
		|| buckets.protectedBucket === buckets.publicBucket) {
		throw new Error('Canonical backfill requires distinct protected and public buckets');
	}
	const cache = new Map<string, Promise<ObjectHeadRecord | null>>();
	const head = (bucket: string, key: string) => {
		const cacheKey = `${bucket}\0${key}`;
		let pending = cache.get(cacheKey);
		if (!pending) {
			pending = verifier.head(bucket, key);
			cache.set(cacheKey, pending);
		}
		return pending;
	};
	return async (expectedBucket, key, expected = {}) => {
		assertLegacyKey(key, 'legacy row');
		const otherBucket = expectedBucket === buckets.publicBucket
			? buckets.protectedBucket
			: buckets.publicBucket;
		let expectedHead: ObjectHeadRecord | null;
		let otherHead: ObjectHeadRecord | null;
		try {
			[expectedHead, otherHead] = await Promise.all([
				head(expectedBucket, key),
				head(otherBucket, key),
			]);
		} catch {
			throw new CanonicalPlanError('OBJECT_HEAD_FAILED', `HEAD failed for ${key}`);
		}
		if (expectedHead && otherHead) {
			throw new CanonicalPlanError('AMBIGUOUS_OBJECT', `object exists in both buckets: ${key}`);
		}
		if (!expectedHead && otherHead) {
			throw new CanonicalPlanError('WRONG_BUCKET', `object exists only in the wrong bucket: ${key}`);
		}
		if (!expectedHead) {
			throw new CanonicalPlanError('MISSING_OBJECT', `object is missing: ${key}`);
		}
		if (expectedHead.size <= 0n) {
			throw new CanonicalPlanError('MALFORMED_LEGACY_ROW', `HEAD returned a non-positive size: ${key}`);
		}
		if (expected.size !== undefined && expectedHead.size !== expected.size) {
			throw new CanonicalPlanError('MALFORMED_LEGACY_ROW', `object size disagrees with DB metadata: ${key}`);
		}
		if (expected.mimeType && normalizedMime(expectedHead.mimeType) !== normalizedMime(expected.mimeType)) {
			throw new CanonicalPlanError('MALFORMED_LEGACY_ROW', `object MIME disagrees with DB metadata: ${key}`);
		}
		if (expectedHead.checksumSha256
			&& !/^[a-f0-9]{64}$/i.test(expectedHead.checksumSha256)) {
			throw new CanonicalPlanError('MALFORMED_LEGACY_ROW', `HEAD returned a malformed SHA-256: ${key}`);
		}
		return expectedHead;
	};
}

type VerifyHead = ReturnType<typeof createVerifiedHead>;

export async function planLegacyAsset(
	row: LegacyAssetRow,
	verify: VerifyHead,
	buckets: CanonicalBuckets,
): Promise<CanonicalAssetPlan | null> {
	if (row.canonicalBackfillComplete) return null;
	if (row.status !== 'READY' || !row.storageKey) return null;
	const bucket = expectedBucketForAsset(row, buckets);
	assertPositiveSize(row.sizeBytes, `asset ${row.id}`);
	const original = await verify(bucket, row.storageKey, {
		size: row.sizeBytes,
		mimeType: row.mimeType,
	});
	const representations: CanonicalRepresentationPlan[] = [representationFromHead(
		row.kind === 'WEBGL' ? 'WEBGL_SOURCE' : 'ORIGINAL',
		bucket,
		row.storageKey,
		original,
		{ width: row.width, height: row.height },
	)];

	if (row.kind === 'VIDEO') {
		if (row.playbackStorageKey && row.playbackStatus !== 'READY') {
			throw new CanonicalPlanError(
				'MALFORMED_LEGACY_ROW',
				`video ${row.id} has a playback key without READY playback state`,
			);
		}
		if (row.playbackStatus === 'READY') {
			if (row.playbackStorageKey) {
				assertPositiveSize(row.playbackSizeBytes, `video ${row.id} playback`);
				const playback = await verify(bucket, row.playbackStorageKey, {
					size: row.playbackSizeBytes,
					mimeType: row.playbackMimeType,
				});
				representations.push(representationFromHead(
					'PLAYBACK', bucket, row.playbackStorageKey, playback,
					{ width: row.width, height: row.height },
				));
			} else if (BROWSER_PLAYABLE_VIDEO_MIMES.has(normalizedMime(original.mimeType))) {
				representations.push(representationFromHead(
					'PLAYBACK', bucket, row.storageKey, original,
					{ width: row.width, height: row.height },
				));
			} else {
				throw new CanonicalPlanError(
					'MALFORMED_LEGACY_ROW',
					`video ${row.id} is READY for playback without a playable representation`,
				);
			}
		}
	}

	let imageRepair: CanonicalAssetPlan['imageRepair'] = null;
	if (IMAGE_KINDS.has(row.kind)) {
		const generation = stableGeneration(representations[0]!);
		const missing: NonNullable<CanonicalAssetPlan['imageRepair']>['missing'] = [];
		for (const rendition of [
			{ role: 'CARD_480' as const, marker: row.card480Height, width: 480 as const, profile: 'card-480' as const },
			{ role: 'DISPLAY_960' as const, marker: row.display960Height, width: 960 as const, profile: 'display-960' as const },
		]) {
			if (rendition.marker === null) {
				missing.push({
					role: rendition.role,
					width: rendition.width,
					objectKey: `public/images/${row.id}/${rendition.role.toLowerCase()}/${generation}.webp`,
				});
				continue;
			}
			if (!Number.isInteger(rendition.marker) || rendition.marker <= 0) {
				throw new CanonicalPlanError('MALFORMED_LEGACY_ROW', `asset ${row.id} has invalid rendition dimensions`);
			}
			const key = renditionKey(row.storageKey, rendition.profile);
			const renditionHead = await verify(bucket, key, { mimeType: 'image/webp' });
			representations.push(representationFromHead(
				rendition.role, bucket, key, renditionHead,
				{ width: rendition.width, height: rendition.marker },
			));
		}
		if (missing.length > 0) {
			imageRepair = {
				sourceBucket: bucket,
				sourceKey: row.storageKey,
				sourceMimeType: row.mimeType,
				sourceSizeBytes: row.sizeBytes,
				missing,
			};
		}
	}
	return { row, representations, imageRepair };
}

export async function planLegacyExhibition(
	row: LegacyExhibitionRow,
	verify: VerifyHead,
	buckets: CanonicalBuckets,
): Promise<CanonicalExhibitionPlan | null> {
	if (!row.posterStorageKey || row.posterAssetId !== null) return null;
	assertPositiveSize(row.posterSizeBytes, `exhibition ${row.id} poster`);
	const original = await verify(buckets.publicBucket, row.posterStorageKey, {
		size: row.posterSizeBytes,
		mimeType: row.posterMimeType,
	});
	const representations = [representationFromHead(
		'ORIGINAL', buckets.publicBucket, row.posterStorageKey, original,
		{ width: row.posterWidth, height: row.posterHeight },
	)];
	const generation = stableGeneration(representations[0]!);
	const missing: NonNullable<CanonicalExhibitionPlan['imageRepair']>['missing'] = [];
	for (const rendition of [
		{ role: 'CARD_480' as const, marker: row.posterCard480Height, width: 480 as const, profile: 'card-480' as const },
		{ role: 'DISPLAY_960' as const, marker: row.posterDisplay960Height, width: 960 as const, profile: 'display-960' as const },
	]) {
		if (rendition.marker === null) {
			missing.push({
				role: rendition.role,
				width: rendition.width,
				objectKey: `public/images/exhibitions/${row.id}/${rendition.role.toLowerCase()}/${generation}.webp`,
			});
			continue;
		}
		if (!Number.isInteger(rendition.marker) || rendition.marker <= 0) {
			throw new CanonicalPlanError('MALFORMED_LEGACY_ROW', `exhibition ${row.id} has invalid rendition dimensions`);
		}
		const key = renditionKey(row.posterStorageKey, rendition.profile);
		const head = await verify(buckets.publicBucket, key, { mimeType: 'image/webp' });
		representations.push(representationFromHead(
			rendition.role, buckets.publicBucket, key, head,
			{ width: rendition.width, height: rendition.marker },
		));
	}
	return {
		row,
		representations,
		imageRepair: missing.length > 0 ? {
			sourceBucket: buckets.publicBucket,
			sourceKey: row.posterStorageKey,
			sourceMimeType: row.posterMimeType,
			sourceSizeBytes: row.posterSizeBytes,
			missing,
		} : null,
	};
}

export async function planLegacyWebgl(
	row: LegacyWebglRow,
	verify: VerifyHead,
	buckets: CanonicalBuckets,
	verifier: CanonicalObjectHeadVerifier,
): Promise<CanonicalWebglPlan | null> {
	if (!row.webglEntryKey || row.currentWebglDeploymentId !== null) return null;
	const deployment = parseWebglEntryKey(row.id, row.webglEntryKey);
	if (!deployment) {
		throw new CanonicalPlanError('MALFORMED_LEGACY_ROW', `project ${row.id} has a malformed WebGL entry key`);
	}
	if (!row.sourceProof) {
		throw new CanonicalPlanError(
			'SOURCE_NOT_PROVEN',
			`project ${row.id} has no completed WEBGL upload proving its current source`,
		);
	}
	if (row.sourceOwnershipConflict) {
		throw new CanonicalPlanError(
			'AMBIGUOUS_OBJECT',
			`project ${row.id} WebGL source key has ambiguous or invalid legacy ownership`,
		);
	}
	if (row.sourceProof.deploymentId !== deployment.deploymentId) {
		throw new CanonicalPlanError(
			'SOURCE_NOT_PROVEN',
			`project ${row.id} completed upload does not prove the active WebGL generation`,
		);
	}
	assertPositiveSize(row.sourceProof.totalBytes, `project ${row.id} WebGL source`);
	const sourceHead = await verify(buckets.protectedBucket, row.sourceProof.storageKey, {
		size: row.sourceProof.totalBytes,
		mimeType: 'application/zip',
	});
	const publicObjects: Array<{ key: string; head: ObjectHeadRecord }> = [];
	let afterKey: string | undefined;
	while (true) {
		let page: { keys: string[]; isTruncated: boolean };
		try {
			page = await verifier.listPrefix(
				buckets.publicBucket,
				deployment.sitePrefix,
				afterKey,
				WEBGL_MANIFEST_PAGE_SIZE,
			);
		} catch {
			throw new CanonicalPlanError('OBJECT_HEAD_FAILED', `LIST failed for WebGL project ${row.id}`);
		}
		if (page.keys.length > WEBGL_MANIFEST_PAGE_SIZE
			|| (page.isTruncated && page.keys.length === 0)) {
			throw new CanonicalPlanError('MALFORMED_LEGACY_ROW', `WebGL listing for project ${row.id} is not safely pageable`);
		}
		for (const key of page.keys) {
			if (!key.startsWith(deployment.sitePrefix) || key === deployment.sitePrefix
				|| (afterKey !== undefined && Buffer.compare(Buffer.from(key), Buffer.from(afterKey)) <= 0)) {
				throw new CanonicalPlanError('MALFORMED_LEGACY_ROW', `WebGL listing for project ${row.id} is not strictly ordered within its generation`);
			}
			if (publicObjects.length >= MAX_WEBGL_MANIFEST_OBJECTS) {
				throw new CanonicalPlanError('MALFORMED_LEGACY_ROW', `WebGL generation for project ${row.id} exceeds ${MAX_WEBGL_MANIFEST_OBJECTS} objects`);
			}
			publicObjects.push({ key, head: await verify(buckets.publicBucket, key) });
			afterKey = key;
		}
		if (!page.isTruncated) break;
	}
	const entry = publicObjects.find((object) => object.key === row.webglEntryKey);
	if (!entry) {
		throw new CanonicalPlanError('MISSING_OBJECT', `WebGL project ${row.id} manifest does not contain index.html`);
	}
	if (normalizedMime(entry.head.mimeType) !== 'text/html') {
		throw new CanonicalPlanError('MALFORMED_LEGACY_ROW', `WebGL project ${row.id} entry MIME is not text/html`);
	}
	const needsIsolatedCopy = row.sourceLegacyAssetKind === 'GAME';
	const sourceDestinationKey = needsIsolatedCopy
		? `protected/assets/webgl/${row.id}/${deployment.deploymentId}/source.zip`
		: row.sourceProof.storageKey;
	return {
		row,
		deploymentId: deployment.deploymentId,
		publicBucket: buckets.publicBucket,
		publicPrefix: deployment.sitePrefix,
		entryObjectKey: deployment.entryKey,
		source: representationFromHead(
			'WEBGL_SOURCE', buckets.protectedBucket, sourceDestinationKey,
			sourceHead, { width: null, height: null },
		),
		sourceCopy: needsIsolatedCopy ? {
			sourceBucket: buckets.protectedBucket,
			sourceKey: row.sourceProof.storageKey,
			destinationBucket: buckets.protectedBucket,
			destinationKey: sourceDestinationKey,
			expected: sourceHead,
		} : null,
		entry: entry.head,
		objectManifest: {
			version: 1,
			objects: publicObjects.map(({ key, head }) => ({
				objectKey: key,
				sizeBytes: head.size.toString(),
				mimeType: head.mimeType,
				etag: head.etag ?? null,
				checksumSha256: head.checksumSha256?.toLowerCase() ?? null,
			})),
		},
	};
}

function emptyStats(): CanonicalBackfillStats {
	return {
		scanned: 0,
		eligible: 0,
		skipped: 0,
		assetsCreated: 0,
		representations: 0,
		deployments: 0,
		objectCopies: 0,
		objectsReused: 0,
		imageRepairs: 0,
		repairsPlanned: 0,
		objectCopiesPlanned: 0,
		failures: 0,
	};
}

export function createCanonicalBackfillProgress(
	mode: CanonicalBackfillMode,
	now = new Date(),
): CanonicalBackfillProgress {
	return {
		version: 1,
		mode,
		phase: 'assets',
		afterId: 0,
		pendingFailures: [],
		updatedAt: now.toISOString(),
	};
}

export function parseCanonicalBackfillProgress(
	value: unknown,
	expectedMode: CanonicalBackfillMode,
): CanonicalBackfillProgress {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Canonical backfill progress must be a JSON object');
	}
	const record = value as Record<string, unknown>;
	if (record['version'] !== 1 || record['mode'] !== expectedMode
		|| !['assets', 'exhibitions', 'webgl', 'done'].includes(String(record['phase']))
		|| !Number.isSafeInteger(record['afterId']) || Number(record['afterId']) < 0
		|| !Array.isArray(record['pendingFailures'])
		|| typeof record['updatedAt'] !== 'string') {
		throw new Error('Canonical backfill progress has an invalid shape or mode');
	}
	for (const failure of record['pendingFailures']) {
		if (!failure || typeof failure !== 'object' || Array.isArray(failure)) {
			throw new Error('Canonical backfill progress contains an invalid failure');
		}
		const candidate = failure as Record<string, unknown>;
		const ref = candidate['ref'];
		if (!ref || typeof ref !== 'object' || Array.isArray(ref)
			|| !['asset', 'exhibition', 'webgl'].includes(String((ref as Record<string, unknown>)['kind']))
			|| !Number.isSafeInteger((ref as Record<string, unknown>)['id'])
			|| typeof candidate['code'] !== 'string'
			|| typeof candidate['message'] !== 'string'
			|| typeof candidate['at'] !== 'string') {
			throw new Error('Canonical backfill progress contains an invalid failure');
		}
	}
	return structuredClone(value) as CanonicalBackfillProgress;
}

export function parseCanonicalBackfillOptions(args: readonly string[]): CanonicalBackfillOptions {
	let apply = false;
	let batchSize = 100;
	for (const arg of args) {
		if (arg === '--apply') apply = true;
		else if (arg === '--dry-run') apply = false;
		else if (arg.startsWith('--batch-size=')) batchSize = Number(arg.slice('--batch-size='.length));
		else if (arg.startsWith('--progress-file=') || arg.startsWith('--failures-file=') || arg.startsWith('--report-file=')
			|| arg === '--reset-progress') continue;
		else throw new Error(`Unknown canonical backfill option: ${arg}`);
	}
	if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
		throw new RangeError('batch-size must be an integer between 1 and 1000');
	}
	return { apply, batchSize };
}

function failureFor(ref: CanonicalWorkRef, error: unknown, now: Date): CanonicalBackfillFailure {
	if (error instanceof CanonicalPlanError) {
		return { ref, code: error.code, message: error.message, at: now.toISOString() };
	}
	const message = error instanceof Error ? error.message : 'unknown canonical backfill failure';
	const code: CanonicalFailureCode = message.includes('changed concurrently')
		? 'CONCURRENT_CHANGE'
		: 'CANONICAL_CONFLICT';
	return { ref, code, message, at: now.toISOString() };
}

function refKey(ref: CanonicalWorkRef): string {
	return `${ref.kind}:${ref.id}`;
}

function addOutcome(stats: CanonicalBackfillStats, outcome: CanonicalApplyOutcome): void {
	stats.assetsCreated += outcome.assetsCreated;
	stats.representations += outcome.representationsUpserted;
	stats.deployments += outcome.deploymentsUpserted;
}

export async function runCanonicalBackfill(deps: {
	repository: CanonicalBackfillRepository;
	verifier: CanonicalObjectHeadVerifier;
	materializer?: CanonicalObjectMaterializer;
	protectedBucket: string;
	publicBucket: string;
	progress: CanonicalBackfillProgress;
	options: CanonicalBackfillOptions;
	now?: () => Date;
	onProgress?: (progress: CanonicalBackfillProgress) => Promise<void>;
	onLog?: (record: Record<string, unknown>) => void;
	afterApplyCommit?: (ref: CanonicalWorkRef) => Promise<void>;
}): Promise<CanonicalBackfillResult> {
	const mode: CanonicalBackfillMode = deps.options.apply ? 'apply' : 'dry-run';
	if (deps.progress.version !== 1 || deps.progress.mode !== mode) {
		throw new Error(`Progress mode/version does not match ${mode}`);
	}
	const now = deps.now ?? (() => new Date());
	const progress: CanonicalBackfillProgress = structuredClone(deps.progress);
	const stats = emptyStats();
	const buckets = { protectedBucket: deps.protectedBucket, publicBucket: deps.publicBucket };
	const verify = createVerifiedHead(deps.verifier, buckets);
	const failures = new Map(progress.pendingFailures.map((failure) => [refKey(failure.ref), failure]));

	const save = async () => {
		progress.pendingFailures = [...failures.values()].sort((a, b) => (
			a.ref.kind.localeCompare(b.ref.kind) || a.ref.id - b.ref.id
		));
		progress.updatedAt = now().toISOString();
		await deps.onProgress?.(structuredClone(progress));
	};

	const processRow = async (
		ref: CanonicalWorkRef,
		row: LegacyAssetRow | LegacyExhibitionRow | LegacyWebglRow | null,
		retrying = false,
	) => {
		stats.scanned += 1;
		let committed = false;
		try {
			if (!row) throw new CanonicalPlanError('MALFORMED_LEGACY_ROW', `${ref.kind} ${ref.id} no longer exists`);
			let plan: CanonicalAssetPlan | CanonicalExhibitionPlan | CanonicalWebglPlan | null;
			if (ref.kind === 'asset') plan = await planLegacyAsset(row as LegacyAssetRow, verify, buckets);
			else if (ref.kind === 'exhibition') plan = await planLegacyExhibition(row as LegacyExhibitionRow, verify, buckets);
			else plan = await planLegacyWebgl(row as LegacyWebglRow, verify, buckets, deps.verifier);
			if (!plan) {
				stats.skipped += 1;
				failures.delete(refKey(ref));
				return;
			}
			stats.eligible += 1;
			if (deps.options.apply) {
				if (ref.kind === 'webgl') {
					const webgl = plan as CanonicalWebglPlan;
					if (webgl.sourceCopy) {
						if (!deps.materializer) {
							throw new CanonicalPlanError('REPAIR_REQUIRED', `webgl ${ref.id} requires an isolated source copy`);
						}
						try {
							const copied = await deps.materializer.ensureWebglSourceCopy(webgl.sourceCopy, {
								beforeCreate: (target) => deps.repository.prepareMaterializationCleanup(target),
							});
							webgl.source = representationFromHead(
								'WEBGL_SOURCE', webgl.sourceCopy.destinationBucket,
								webgl.sourceCopy.destinationKey, copied.head,
								{ width: null, height: null },
							);
							webgl.source.sourceIdentityAlgorithm = 'MIGRATION_COPY_SHA256';
							stats[copied.created ? 'objectCopies' : 'objectsReused'] += 1;
						} catch (error) {
							if (error instanceof CanonicalPlanError) throw error;
							throw new CanonicalPlanError('COPY_FAILED', `webgl ${ref.id} source copy failed: ${error instanceof Error ? error.message : String(error)}`);
						}
					}
				} else {
					const imagePlan = plan as CanonicalAssetPlan | CanonicalExhibitionPlan;
					if (imagePlan.imageRepair) {
						if (!deps.materializer) {
							throw new CanonicalPlanError('REPAIR_REQUIRED', `${ref.kind} ${ref.id} requires responsive image repair`);
						}
						try {
							const repaired = await deps.materializer.ensureImageRenditions(imagePlan.imageRepair, {
								beforeCreate: (target) => deps.repository.prepareMaterializationCleanup(target),
							});
							const expectedRoles = new Set(imagePlan.imageRepair.missing.map(({ role }) => role));
							if (repaired.representations.length !== expectedRoles.size
								|| repaired.representations.some((candidate) => !expectedRoles.has(candidate.role as 'CARD_480' | 'DISPLAY_960'))) {
								throw new Error('materializer returned an incomplete rendition set');
							}
							imagePlan.representations.push(...repaired.representations);
							stats.imageRepairs += repaired.created;
							stats.objectsReused += repaired.reused;
						} catch (error) {
							if (error instanceof CanonicalPlanError) throw error;
							throw new CanonicalPlanError('REPAIR_FAILED', `${ref.kind} ${ref.id} image repair failed: ${error instanceof Error ? error.message : String(error)}`);
						}
					}
					const requiresPublicImageNamespace = ref.kind === 'exhibition'
						|| (ref.kind === 'asset' && IMAGE_KINDS.has((imagePlan as CanonicalAssetPlan).row.kind));
					if (requiresPublicImageNamespace) {
						if (!deps.materializer) {
							throw new CanonicalPlanError('REPAIR_REQUIRED', `${ref.kind} ${ref.id} requires canonical publication relocation`);
						}
						try {
							const relocated = await materializeRepresentationNamespace({
								representations: imagePlan.representations,
								destinationBucket: buckets.publicBucket,
								ownerPrefix: ref.kind === 'asset'
									? `public/images/${ref.id}`
									: `public/images/exhibitions/${ref.id}`,
								materializer: deps.materializer,
								repository: deps.repository,
								workKind: ref.kind,
								workRef: String(ref.id),
							});
							imagePlan.representations = relocated.representations;
							imagePlan.relocations = relocated.relocations;
							stats.objectCopies += relocated.created;
							stats.objectsReused += relocated.reused;
						} catch (error) {
							if (error instanceof CanonicalPlanError) throw error;
							throw new CanonicalPlanError('COPY_FAILED', `${ref.kind} ${ref.id} publication relocation failed: ${error instanceof Error ? error.message : String(error)}`);
						}
					}
				}
				const outcome = ref.kind === 'asset'
					? await deps.repository.applyAsset(plan as CanonicalAssetPlan)
					: ref.kind === 'exhibition'
						? await deps.repository.applyExhibition(plan as CanonicalExhibitionPlan)
						: await deps.repository.applyWebgl(plan as CanonicalWebglPlan);
				addOutcome(stats, outcome);
				committed = true;
				await deps.afterApplyCommit?.(ref);
			} else {
				stats.assetsCreated += ref.kind === 'asset'
					? 0
					: ref.kind === 'webgl' && (plan as CanonicalWebglPlan).row.sourceLegacyAssetKind === 'WEBGL'
						? 0
						: 1;
				if (ref.kind === 'webgl') {
					stats.representations += 1;
					stats.repairsPlanned += (plan as CanonicalWebglPlan).sourceCopy ? 1 : 0;
				} else {
					const imagePlan = plan as CanonicalAssetPlan | CanonicalExhibitionPlan;
					stats.representations += imagePlan.representations.length + (imagePlan.imageRepair?.missing.length ?? 0);
					stats.repairsPlanned += imagePlan.imageRepair?.missing.length ?? 0;
					const requiresPublicImageNamespace = ref.kind === 'exhibition'
						|| (ref.kind === 'asset' && IMAGE_KINDS.has((imagePlan as CanonicalAssetPlan).row.kind));
					if (requiresPublicImageNamespace) {
						const ownerPrefix = ref.kind === 'asset'
							? `public/images/${ref.id}`
							: `public/images/exhibitions/${ref.id}`;
						stats.objectCopiesPlanned += imagePlan.representations.filter((representation) => (
							representation.bucket !== buckets.publicBucket
							|| !representation.objectKey.startsWith(`${ownerPrefix}/${representation.role.toLowerCase()}/`)
						)).length;
					}
				}
				stats.deployments += ref.kind === 'webgl' ? 1 : 0;
			}
			failures.delete(refKey(ref));
			deps.onLog?.({ event: 'canonical_backfill_row', mode, ...ref, status: 'ok', retrying });
		} catch (error) {
			// A hook after the row transaction models process death after commit but
			// before the durable JSON cursor is advanced. It must terminate the run;
			// converting it to a row failure would incorrectly persist a later cursor.
			if (committed) throw error;
			const failure = failureFor(ref, error, now());
			failures.set(refKey(ref), failure);
			deps.onLog?.({ event: 'canonical_backfill_row', mode, ...ref, status: 'failed', code: failure.code, retrying });
		}
	};

	for (const pending of [...progress.pendingFailures]) {
		const row = pending.ref.kind === 'asset'
			? await deps.repository.getAsset(pending.ref.id)
			: pending.ref.kind === 'exhibition'
				? await deps.repository.getExhibition(pending.ref.id)
				: await deps.repository.getWebglProject(pending.ref.id);
		await processRow(pending.ref, row, true);
		await save();
	}

	while (progress.phase !== 'done') {
		const phase = progress.phase;
		const rows = phase === 'assets'
			? await deps.repository.listAssets(progress.afterId, deps.options.batchSize)
			: phase === 'exhibitions'
				? await deps.repository.listExhibitions(progress.afterId, deps.options.batchSize)
				: await deps.repository.listWebglProjects(progress.afterId, deps.options.batchSize);
		let previous = progress.afterId;
		for (const row of rows) {
			if (!Number.isSafeInteger(row.id) || row.id <= previous) {
				throw new Error(`${phase} keyset page is not strictly ascending`);
			}
			previous = row.id;
			const kind = phase === 'assets' ? 'asset' : phase === 'exhibitions' ? 'exhibition' : 'webgl';
			await processRow({ kind, id: row.id }, row);
			progress.afterId = row.id;
			await save();
		}
		deps.onLog?.({ event: 'canonical_backfill_batch', mode, phase, count: rows.length, afterId: progress.afterId });
		if (rows.length === deps.options.batchSize) continue;
		const phaseIndex = PHASES.indexOf(phase);
		progress.phase = PHASES[phaseIndex + 1] ?? 'done';
		progress.afterId = 0;
		await save();
	}

	stats.failures = failures.size;
	return {
		mode,
		stats,
		progress,
		failures: [...failures.values()],
	};
}
