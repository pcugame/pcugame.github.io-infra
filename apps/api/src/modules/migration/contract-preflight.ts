/**
 * Read-only Phase-2 contract gate. This is deliberately separate from the
 * backfill: it reports whether it is safe to remove Phase-1 bridges, but never
 * writes canonical objects or metadata (except the explicit metric reset).
 */

export const LEGACY_BRIDGE_METRIC_NAMES = [
	'asset_download_legacy_fallback',
	'asset_download_legacy_route',
	'public_image_legacy_bridge',
	'public_image_legacy_fallback',
	'public_webgl_legacy_bridge',
	'public_webgl_legacy_fallback',
	'export_legacy_fallback',
] as const;

export type ContractPreflightBlocker =
	| 'legacyOnlyActiveAssets'
	| 'unresolvedRepresentations'
	| 'missingObjects'
	| 'objectMetadataMismatches'
	| 'duplicateCanonicalOwnership'
	| 'malformedWebglDeployments'
	| 'legacyBridgeObservations'
	| 'playbackOrphans'
	| 'unknownInventoryOwnership'
	| 'activeLegacyUploadSessions'
	| 'bucketPolicyViolations'
	| 'activeGarageMultipartUploads'
	| 'pendingCleanupOutbox'
	| 'incompleteObjectRelocations';

export type ContractAssetRepresentation = {
	id: string;
	assetId: number;
	role: string;
	bucket: string;
	objectKey: string;
	publicationBucket: string | null;
	publicationObjectKey: string | null;
	mimeType: string;
	sizeBytes: bigint;
	checksumAlgorithm: string | null;
	checksum: string | null;
	etag: string | null;
	sourceIdentityAlgorithm: string | null;
	sourceIdentity: string | null;
	state: string;
};

export type ContractAssetRow = {
	id: number;
	projectId: number | null;
	exhibitionId: number | null;
	kind: string;
	status: string;
	storageKey: string | null;
	playbackStorageKey: string | null;
	playbackStatus: string;
	card480Height: number | null;
	display960Height: number | null;
	representations: ContractAssetRepresentation[];
};

export type ContractExhibitionRow = {
	id: number;
	posterStorageKey: string | null;
	posterAssetId: number | null;
	posterCard480Height: number | null;
	posterDisplay960Height: number | null;
};

export type ContractWebglDeployment = {
	id: string;
	projectId: number;
	sourceRepresentationId: string;
	publicBucket: string;
	publicPrefix: string;
	entryObjectKey: string;
	objectManifest: unknown;
	stagingBucket: string | null;
	stagingPrefix: string | null;
	stagingEntryObjectKey: string | null;
	stagingObjectManifest: unknown;
	state: string;
};

export type ContractProjectRow = {
	id: number;
	status: string;
	webglEntryKey: string;
	currentWebglDeploymentId: string | null;
	currentWebglDeployment: ContractWebglDeployment | null;
};

export type ContractStorageBucket = {
	bucket: string;
	visibility: 'PROTECTED' | 'PUBLIC';
};

export type ContractCleanupTask = {
	kind: 'MULTIPART_ABORT' | 'ORPHAN_OBJECT' | 'UPLOAD_INTENT';
	id: string;
	state: string;
};

export type ContractMetric = {
	name: string;
	scope: string;
	value: bigint;
	lastObservedAt: Date | null;
};

export type ContractUploadSession = {
	id: string;
	status: string;
	uploadKind: string;
	storageKey: string | null;
};

export type ContractObjectRelocation = {
	id: string;
	workKind: string;
	workRef: string;
	role: string;
	sourceBucket: string;
	sourceObjectKey: string;
	destinationBucket: string;
	destinationObjectKey: string;
	sizeBytes: bigint;
	mimeType: string;
	checksumSha256: string | null;
	state: string;
};

export type ContractPreflightSnapshot = {
	assets: ContractAssetRow[];
	exhibitions: ContractExhibitionRow[];
	projects: ContractProjectRow[];
	deployments: ContractWebglDeployment[];
	metrics: ContractMetric[];
	uploadSessions: ContractUploadSession[];
	cleanupTasks: ContractCleanupTask[];
	storageBuckets: ContractStorageBucket[];
	relocations: ContractObjectRelocation[];
};

export type ContractInventoryObject = { bucket: string; key: string };
export type ContractInventorySnapshot = {
	identity: string;
	capturedAt: string;
	objects: ContractInventoryObject[];
	multipartUploads: Array<{ bucket: string; key: string; uploadId: string }>;
};

export type ContractPreflightRepository = {
	readSnapshot(): Promise<ContractPreflightSnapshot>;
	resetLegacyBridgeObservations(observedAt: Date): Promise<void>;
};

export type ContractHeadMetadata = {
	sizeBytes: bigint;
	mimeType: string;
	etag: string | null;
	checksumSha256: string | null;
};

export type ContractHead = (
	bucket: string,
	key: string,
	signal: AbortSignal,
) => Promise<ContractHeadMetadata | null>;

export type ContractPreflightOptions = {
	batchSize?: number;
	headTimeoutMs?: number;
	resetObservation?: boolean;
	resetConfirmation?: string;
	protectedBucket?: string;
	publicBucket?: string;
	observationWindowMs?: number;
};

export type ContractPreflightReport = {
	version: 2;
	startedAt: string;
	finishedAt: string;
	inventorySnapshot: { identity: string; capturedAt: string; objectCount: number };
	counts: {
		legacyRowsTotal: number;
		legacyRowsTerminal: number;
		backfilledCanonicalRows: number;
		verifiedCanonicalObjects: number;
		verifiedRelocationSources: number;
		physicalCopies: number;
		generatedRenditions: number;
		unresolvedRows: number;
		orphanObjects: number;
		duplicateOwnership: number;
		legacyFallbackReads: number;
	};
	blockers: Record<ContractPreflightBlocker, { count: number; samples: string[] }>;
	clean: boolean;
	metricObservationReset: boolean;
};

export const CONTRACT_PREFLIGHT_RESET_CONFIRMATION = 'RESET_LEGACY_BRIDGE_OBSERVATION';
const TERMINAL_ASSET_STATUSES = new Set(['DELETED', 'FAILED']);
const TERMINAL_UPLOAD_STATUSES = new Set([
	'COMPLETED', 'CANCELLED', 'FAILED', 'RESOLVED',
	'READY', 'REJECTED', 'EXPIRED',
]);
const BLOCKERS: readonly ContractPreflightBlocker[] = [
	'legacyOnlyActiveAssets', 'unresolvedRepresentations', 'missingObjects', 'objectMetadataMismatches',
	'duplicateCanonicalOwnership', 'malformedWebglDeployments', 'legacyBridgeObservations',
	'playbackOrphans', 'unknownInventoryOwnership', 'activeLegacyUploadSessions',
	'bucketPolicyViolations', 'activeGarageMultipartUploads', 'pendingCleanupOutbox',
	'incompleteObjectRelocations',
];

function samples(values: Iterable<string>, maximum = 20): string[] {
	return [...new Set(values)].sort().slice(0, maximum);
}

function active(asset: ContractAssetRow): boolean {
	return !TERMINAL_ASSET_STATUSES.has(asset.status);
}

function expectedSourceRole(asset: ContractAssetRow): string {
	return asset.kind === 'WEBGL' ? 'WEBGL_SOURCE' : 'ORIGINAL';
}

function timeout<T>(work: Promise<T>, ms: number, controller: AbortController): Promise<T> {
	let handle: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<never>((_resolve, reject) => {
		handle = setTimeout(() => {
			controller.abort();
			reject(new Error(`Garage HEAD timed out after ${ms}ms`));
		}, ms);
	});
	return Promise.race([work, expiry]).finally(() => {
		if (handle) clearTimeout(handle);
	});
}

async function mapBounded<T, R>(
	values: readonly T[],
	limit: number,
	work: (value: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(values.length);
	let cursor = 0;
	const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
		while (true) {
			const index = cursor++;
			if (index >= values.length) return;
			results[index] = await work(values[index]!);
		}
	});
	await Promise.all(workers);
	return results;
}

function emptyBlockers(): ContractPreflightReport['blockers'] {
	return Object.fromEntries(BLOCKERS.map((name) => [name, { count: 0, samples: [] }])) as unknown as ContractPreflightReport['blockers'];
}

type ValidManifestObject = {
	objectKey: string;
	sizeBytes: bigint;
	mimeType: string;
	etag: string | null;
	checksumSha256: string | null;
};

function manifestObjects(value: unknown): ValidManifestObject[] | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record['version'] !== 1 || !Array.isArray(record['objects']) || record['objects'].length === 0) return null;
	const objects: ValidManifestObject[] = [];
	const keys = new Set<string>();
	for (const value of record['objects']) {
		if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
		const object = value as Record<string, unknown>;
		if (typeof object['objectKey'] !== 'string' || !object['objectKey']
			|| typeof object['sizeBytes'] !== 'string' || !/^\d+$/.test(object['sizeBytes'])
			|| typeof object['mimeType'] !== 'string' || !object['mimeType']
			|| !(object['etag'] === null || typeof object['etag'] === 'string')
			|| !(object['checksumSha256'] === null
				|| (typeof object['checksumSha256'] === 'string' && /^[a-f0-9]{64}$/i.test(object['checksumSha256'])))) return null;
		if (keys.has(object['objectKey'])) return null;
		keys.add(object['objectKey']);
		objects.push({
			objectKey: object['objectKey'],
			sizeBytes: BigInt(object['sizeBytes']),
			mimeType: object['mimeType'],
			etag: object['etag'],
			checksumSha256: object['checksumSha256'],
		});
	}
	return objects;
}

type RequiredObject = {
	bucket: string;
	key: string;
	expectations: Array<{
		owner: string;
		requireIdentity: boolean;
		metadata: {
			sizeBytes: bigint;
			mimeType: string;
			checksumSha256: string | null;
			etag: string | null;
			sourceIdentityAlgorithm: string | null;
			sourceIdentity: string | null;
		};
	}>;
	owners: Set<string>;
};

type ExpectedObjectMetadata = RequiredObject['expectations'][number]['metadata'];

function normalizedMime(value: string): string {
	return value.split(';', 1)[0]!.trim().toLowerCase();
}

function normalizedEtag(value: string | null): string | null {
	if (!value) return null;
	return value.trim().replace(/^"|"$/g, '').toLowerCase();
}

function metadataMismatches(expected: ExpectedObjectMetadata, actual: ContractHeadMetadata): string[] {
	const mismatches: string[] = [];
	if (actual.sizeBytes !== expected.sizeBytes) mismatches.push(`size:${actual.sizeBytes}->${expected.sizeBytes}`);
	if (normalizedMime(actual.mimeType) !== normalizedMime(expected.mimeType)) {
		mismatches.push(`mime:${normalizedMime(actual.mimeType)}->${normalizedMime(expected.mimeType)}`);
	}
	const expectedChecksum = expected.checksumSha256?.toLowerCase() ?? null;
	const actualChecksum = actual.checksumSha256?.toLowerCase() ?? null;
	const expectedEtag = normalizedEtag(expected.etag);
	const actualEtag = normalizedEtag(actual.etag);
	const sourceAlgorithm = expected.sourceIdentityAlgorithm?.toUpperCase() ?? null;
	const sourceIdentity = expected.sourceIdentity?.toLowerCase() ?? null;
	if (expectedChecksum) {
		if (actualChecksum) {
			if (expectedChecksum !== actualChecksum) mismatches.push('sha256');
		} else mismatches.push('sha256-unverifiable');
	} else if (sourceAlgorithm?.endsWith('SHA256') && sourceIdentity) {
		if (actualChecksum) {
			if (sourceIdentity !== actualChecksum) mismatches.push('source-sha256');
		} else mismatches.push('source-sha256-unverifiable');
	} else if (expectedEtag) {
		if (!actualEtag) mismatches.push('etag-unavailable');
		else if (expectedEtag !== actualEtag) mismatches.push('etag');
	} else if (sourceAlgorithm === 'S3_ETAG_SIZE' && sourceIdentity) {
		if (!actualEtag) mismatches.push('source-etag-size-unverifiable');
		else {
			const actualIdentity = `${actualEtag}:${actual.sizeBytes}`.toLowerCase();
			if (sourceIdentity !== actualIdentity) mismatches.push('source-etag-size');
		}
	} else mismatches.push('identity-unverifiable');
	return mismatches;
}

function expectedMetadataConflicts(left: ExpectedObjectMetadata, right: ExpectedObjectMetadata): boolean {
	return left.sizeBytes !== right.sizeBytes
		|| normalizedMime(left.mimeType) !== normalizedMime(right.mimeType)
		|| (!!left.checksumSha256 && !!right.checksumSha256
			&& left.checksumSha256.toLowerCase() !== right.checksumSha256.toLowerCase())
		|| (!!left.etag && !!right.etag && normalizedEtag(left.etag) !== normalizedEtag(right.etag));
}

function deploymentIsMalformed(
	deployment: ContractWebglDeployment,
	project: ContractProjectRow | undefined,
	representationById: ReadonlyMap<string, { representation: ContractAssetRepresentation; asset: ContractAssetRow }>,
	expectedPublicBucket: string,
): string | null {
	if (!project || deployment.projectId !== project.id) return `deployment:${deployment.id}:project-ownership`;
	const source = representationById.get(deployment.sourceRepresentationId);
	if (!source) return `deployment:${deployment.id}:missing-source-representation`;
	if (source.representation.role !== 'WEBGL_SOURCE' || source.asset.projectId !== project.id
		|| source.asset.kind !== 'WEBGL') return `deployment:${deployment.id}:invalid-source-ownership`;
	if (deployment.state === 'READY' && (source.representation.state !== 'READY' || source.asset.status !== 'READY')) {
		return `deployment:${deployment.id}:nonready-source`;
	}
	if (deployment.publicBucket !== expectedPublicBucket) return `deployment:${deployment.id}:wrong-public-bucket`;
	if (!deployment.publicBucket || !deployment.publicPrefix || !deployment.entryObjectKey
		|| !deployment.entryObjectKey.startsWith(deployment.publicPrefix)
		|| !deployment.publicPrefix.endsWith('/')) return `deployment:${deployment.id}:invalid-public-identity`;
	if (deployment.state !== 'READY') return null;
	if (project.status === 'DRAFT') {
		const stagingManifest = manifestObjects(deployment.stagingObjectManifest);
		if (!deployment.stagingBucket || !deployment.stagingPrefix || !deployment.stagingEntryObjectKey
			|| deployment.objectManifest !== null || !stagingManifest
			|| stagingManifest.some((object) => !object.objectKey.startsWith(deployment.stagingPrefix!))
			|| !stagingManifest.some((object) => object.objectKey === deployment.stagingEntryObjectKey)) {
			return `deployment:${deployment.id}:invalid-staging-manifest`;
		}
	} else {
		const manifest = manifestObjects(deployment.objectManifest);
		if (deployment.stagingBucket !== null || deployment.stagingPrefix !== null
			|| deployment.stagingEntryObjectKey !== null || deployment.stagingObjectManifest !== null
			|| !manifest || manifest.some((object) => !object.objectKey.startsWith(deployment.publicPrefix))
			|| !manifest.some((object) => object.objectKey === deployment.entryObjectKey)) {
			return `deployment:${deployment.id}:invalid-object-manifest`;
		}
	}
	return null;
}

/**
 * Runs all nine Phase-2 blockers against one DB snapshot and an inventory
 * captured by the caller. A HEAD failure is operational, never misreported as
 * a clean missing object.
 */
export async function runContractPreflight(input: {
	repository: ContractPreflightRepository;
	inventory: ContractInventorySnapshot;
	head: ContractHead;
	now?: () => Date;
	options?: ContractPreflightOptions;
}): Promise<ContractPreflightReport> {
	const started = (input.now ?? (() => new Date()))();
	const options = input.options ?? {};
	const protectedBucket = options.protectedBucket ?? 'protected';
	const publicBucket = options.publicBucket ?? 'public';
	if (!protectedBucket || !publicBucket || protectedBucket === publicBucket) throw new Error('preflight requires distinct protected/public buckets');
	if (options.resetObservation && options.resetConfirmation !== CONTRACT_PREFLIGHT_RESET_CONFIRMATION) {
		throw new Error(`Observation reset requires --confirm-reset=${CONTRACT_PREFLIGHT_RESET_CONFIRMATION}`);
	}
	if (options.resetObservation) await input.repository.resetLegacyBridgeObservations(started);
	const snapshot = await input.repository.readSnapshot();
	const blockers = emptyBlockers();
	const activeAssets = snapshot.assets.filter(active);
	const terminalAssets = snapshot.assets.filter((asset) => !active(asset));
	const representations = activeAssets.flatMap((asset) => asset.representations.map((representation) => ({ ...representation, asset })));
	const allRepresentations = snapshot.assets.flatMap((asset) => asset.representations.map((representation) => ({ ...representation, asset })));
	const assetById = new Map(snapshot.assets.map((asset) => [asset.id, asset]));
	const representationById = new Map(snapshot.assets.flatMap((asset) => asset.representations.map((representation) => (
		[representation.id, { representation, asset }] as const
	))));
	const projectById = new Map(snapshot.projects.map((project) => [project.id, project]));
	const unresolvedRowIdentities = new Set<string>();

	const legacyOnlyAssets = activeAssets.filter((asset) => (
		(asset.storageKey !== null || asset.playbackStorageKey !== null)
		&& !asset.representations.some((representation) => representation.role === expectedSourceRole(asset) && representation.state === 'READY')
	));
	const legacyOnlyExhibitions = snapshot.exhibitions.filter((exhibition) => (
		exhibition.posterStorageKey !== null && exhibition.posterAssetId === null
	));
	for (const asset of legacyOnlyAssets) unresolvedRowIdentities.add(`asset:${asset.id}`);
	for (const exhibition of legacyOnlyExhibitions) unresolvedRowIdentities.add(`exhibition:${exhibition.id}`);
	blockers.legacyOnlyActiveAssets = {
		count: legacyOnlyAssets.length + legacyOnlyExhibitions.length,
		samples: samples([
			...legacyOnlyAssets.map((asset) => `asset:${asset.id}`),
			...legacyOnlyExhibitions.map((exhibition) => `exhibition:${exhibition.id}:poster`),
		]),
	};

	const unresolved = representations.filter((representation) => (
		representation.state !== 'READY' || !representation.bucket || !representation.objectKey
	));
	for (const representation of unresolved) unresolvedRowIdentities.add(`asset:${representation.assetId}`);
	const missingRequiredRoles: string[] = snapshot.assets
		.filter((asset) => Number(asset.projectId !== null) + Number(asset.exhibitionId !== null) !== 1)
		.map((asset) => `asset:${asset.id}:invalid-owner-count`);
	for (const asset of snapshot.assets) {
		if (Number(asset.projectId !== null) + Number(asset.exhibitionId !== null) !== 1) {
			unresolvedRowIdentities.add(`asset:${asset.id}`);
		}
	}
	for (const asset of activeAssets) {
		const requiredRoles = [expectedSourceRole(asset)];
		if (['IMAGE', 'POSTER', 'THUMBNAIL'].includes(asset.kind)) {
			requiredRoles.push('CARD_480', 'DISPLAY_960');
		}
		for (const role of requiredRoles) {
			if (!asset.representations.some((representation) => representation.role === role && representation.state === 'READY')) {
				missingRequiredRoles.push(`asset:${asset.id}:missing-${role}`);
				unresolvedRowIdentities.add(`asset:${asset.id}`);
			}
		}
	}
	const malformedExhibitionPointers: string[] = [];
	for (const exhibition of snapshot.exhibitions) {
		if (exhibition.posterAssetId === null) continue;
		const poster = assetById.get(exhibition.posterAssetId);
		if (!poster || !active(poster) || poster.kind !== 'POSTER'
			|| poster.exhibitionId !== exhibition.id || poster.projectId !== null) {
			malformedExhibitionPointers.push(`exhibition:${exhibition.id}:invalid-poster-owner`);
			unresolvedRowIdentities.add(`exhibition:${exhibition.id}`);
			continue;
		}
		for (const role of [
			'ORIGINAL',
			'CARD_480',
			'DISPLAY_960',
		]) {
			if (!poster.representations.some((representation) => representation.role === role && representation.state === 'READY')) {
				malformedExhibitionPointers.push(`exhibition:${exhibition.id}:missing-${role}`);
				unresolvedRowIdentities.add(`exhibition:${exhibition.id}`);
			}
		}
	}
	blockers.unresolvedRepresentations = {
		count: unresolved.length + missingRequiredRoles.length + malformedExhibitionPointers.length,
		samples: samples([
			...unresolved.map((representation) => `representation:${representation.id}`),
			...missingRequiredRoles,
			...malformedExhibitionPointers,
		]),
	};

	const readyDeployments = snapshot.deployments.filter((deployment) => deployment.state === 'READY');
	const malformed = snapshot.deployments
		.map((deployment) => deploymentIsMalformed(deployment, projectById.get(deployment.projectId), representationById, publicBucket))
		.filter((value): value is string => value !== null);
	for (const deployment of snapshot.deployments) {
		if (deploymentIsMalformed(deployment, projectById.get(deployment.projectId), representationById, publicBucket)) {
			unresolvedRowIdentities.add(`deployment:${deployment.id}`);
		}
	}
	for (const project of snapshot.projects) {
		if (project.currentWebglDeploymentId === null) {
			if (project.webglEntryKey) {
				malformed.push(`project:${project.id}:legacy-pointer-without-deployment`);
				unresolvedRowIdentities.add(`project:${project.id}`);
			}
			continue;
		}
		const deployment = snapshot.deployments.find((candidate) => candidate.id === project.currentWebglDeploymentId);
		if (!deployment || deployment.projectId !== project.id || deployment.state !== 'READY') {
			malformed.push(`project:${project.id}:dangling-or-nonready-current-pointer`);
			unresolvedRowIdentities.add(`project:${project.id}`);
		}
	}
	blockers.malformedWebglDeployments = { count: malformed.length, samples: samples(malformed) };

	const businessData = snapshot.assets.length + snapshot.exhibitions.length + snapshot.projects.length > 0;
	const observationCutoff = started.getTime() - (options.observationWindowMs ?? 24 * 60 * 60 * 1_000);
	const unsafeMetrics: string[] = [];
	for (const name of LEGACY_BRIDGE_METRIC_NAMES) {
		const rows = snapshot.metrics.filter((metric) => metric.name === name);
		if (!businessData) continue;
		if (rows.length === 0) unsafeMetrics.push(`metric:${name}:missing`);
		else for (const metric of rows) {
			if (metric.value !== 0n) unsafeMetrics.push(`metric:${metric.name}:${metric.scope}=${metric.value}`);
			else if (!metric.lastObservedAt || metric.lastObservedAt.getTime() > observationCutoff) unsafeMetrics.push(`metric:${metric.name}:${metric.scope}:observation-window`);
		}
	}
	const bridgeMetrics = snapshot.metrics.filter((metric) => LEGACY_BRIDGE_METRIC_NAMES.includes(metric.name as typeof LEGACY_BRIDGE_METRIC_NAMES[number]) && metric.value > 0n);
	const fallbackReads = bridgeMetrics.reduce((total, metric) => total + metric.value, 0n);
	blockers.legacyBridgeObservations = {
		count: unsafeMetrics.length,
		samples: samples(unsafeMetrics),
	};

	const playbackOrphans = activeAssets.filter((asset) => (
		asset.kind === 'VIDEO'
		&& asset.status === 'READY'
		&& asset.playbackStatus === 'READY'
		&& (() => {
			const playback = asset.representations.find((representation) => representation.role === 'PLAYBACK' && representation.state === 'READY');
			return !playback || (asset.playbackStorageKey !== null && playback.objectKey !== asset.playbackStorageKey);
		})()
	));
	for (const asset of playbackOrphans) unresolvedRowIdentities.add(`asset:${asset.id}`);
	blockers.playbackOrphans = { count: playbackOrphans.length, samples: samples(playbackOrphans.map((asset) => `asset:${asset.id}`)) };

	const activeUploads = snapshot.uploadSessions.filter((session) => !TERMINAL_UPLOAD_STATUSES.has(session.status));
	blockers.activeLegacyUploadSessions = { count: activeUploads.length, samples: samples(activeUploads.map((session) => `session:${session.id}:${session.status}`)) };

	const bucketViolations: string[] = [];
	const bucketVisibility = new Map(snapshot.storageBuckets.map((entry) => [entry.bucket, entry.visibility]));
	if (bucketVisibility.get(protectedBucket) !== 'PROTECTED') {
		bucketViolations.push(`registry:${protectedBucket}->PROTECTED`);
	}
	if (bucketVisibility.get(publicBucket) !== 'PUBLIC') {
		bucketViolations.push(`registry:${publicBucket}->PUBLIC`);
	}
	for (const { asset, ...representation } of representations) {
		if (representation.state !== 'READY') continue;
		const expectsPublic = representation.role === 'CARD_480' || representation.role === 'DISPLAY_960'
			|| (representation.role === 'ORIGINAL' && ['IMAGE', 'POSTER', 'THUMBNAIL'].includes(asset.kind));
		const project = asset.projectId === null ? undefined : projectById.get(asset.projectId);
		const stagedDraftImage = project?.status === 'DRAFT' && expectsPublic && representation.publicationBucket !== null;
		const expectedVisibility = stagedDraftImage ? 'PROTECTED' : expectsPublic ? 'PUBLIC' : 'PROTECTED';
		if (bucketVisibility.get(representation.bucket) !== expectedVisibility) {
			bucketViolations.push(`representation:${representation.id}:${representation.bucket}->${expectedVisibility}`);
		}
		if (representation.publicationBucket !== null
			&& bucketVisibility.get(representation.publicationBucket) !== 'PUBLIC') {
			bucketViolations.push(`representation-target:${representation.id}:${representation.publicationBucket}->PUBLIC`);
		}
		if (!expectsPublic) continue;
		if (project?.status === 'DRAFT') {
			const stagingPrefix = `protected/publication-staging/projects/${project.id}/images/`;
			const stagingSuffix = representation.objectKey.startsWith(stagingPrefix)
				? representation.objectKey.slice(stagingPrefix.length)
				: '';
			const scopedUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\//i;
			if (bucketVisibility.get(representation.bucket) !== 'PROTECTED'
				|| !scopedUuid.test(stagingSuffix)
				|| representation.publicationBucket === null
				|| representation.publicationObjectKey === null
				|| !representation.publicationObjectKey.startsWith('public/images/')
				|| !representation.sourceIdentityAlgorithm?.trim()
				|| !representation.sourceIdentity?.trim()) {
				bucketViolations.push(`representation-publication-state:${representation.id}:DRAFT`);
			}
		} else if (project?.status === 'PUBLISHED' || project?.status === 'ARCHIVED' || project === undefined) {
			if (!representation.objectKey.startsWith('public/images/')
				|| representation.publicationBucket !== null
				|| representation.publicationObjectKey !== null) {
				bucketViolations.push(`representation-publication-state:${representation.id}:PUBLISHED`);
			}
		}
	}
	for (const deployment of snapshot.deployments) {
		if (bucketVisibility.get(deployment.publicBucket) !== 'PUBLIC') {
			bucketViolations.push(`deployment-public:${deployment.id}:${deployment.publicBucket}->PUBLIC`);
		}
		if (deployment.stagingBucket !== null && bucketVisibility.get(deployment.stagingBucket) !== 'PROTECTED') {
			bucketViolations.push(`deployment-staging:${deployment.id}:${deployment.stagingBucket}->PROTECTED`);
		}
	}
	blockers.bucketPolicyViolations = { count: bucketViolations.length, samples: samples(bucketViolations) };

	const relocationViolations: string[] = [];
	for (const relocation of snapshot.relocations) {
		if (relocation.state !== 'COMMITTED' || !relocation.checksumSha256
			|| !/^[a-f0-9]{64}$/i.test(relocation.checksumSha256)) {
			relocationViolations.push(`relocation:${relocation.id}:${relocation.state}`);
			continue;
		}
		const destination = allRepresentations.find((candidate) => (
			candidate.state === 'READY'
			&& candidate.bucket === relocation.destinationBucket
			&& candidate.objectKey === relocation.destinationObjectKey
			&& candidate.role === relocation.role
		));
		if (!destination || destination.sizeBytes !== relocation.sizeBytes
			|| normalizedMime(destination.mimeType) !== normalizedMime(relocation.mimeType)
			|| destination.checksumAlgorithm?.toUpperCase() !== 'SHA256'
			|| destination.checksum?.toLowerCase() !== relocation.checksumSha256.toLowerCase()
			|| (relocation.workKind === 'asset' && String(destination.assetId) !== relocation.workRef)
			|| (relocation.workKind === 'exhibition'
				&& !snapshot.exhibitions.some((exhibition) => (
					String(exhibition.id) === relocation.workRef && exhibition.posterAssetId === destination.assetId
				)))) {
			relocationViolations.push(`relocation:${relocation.id}:destination-mismatch`);
		}
	}
	blockers.incompleteObjectRelocations = {
		count: relocationViolations.length,
		samples: samples(relocationViolations),
	};

	const activeMultipart = input.inventory.multipartUploads ?? [];
	blockers.activeGarageMultipartUploads = {
		count: activeMultipart.length,
		samples: samples(activeMultipart.map((upload) => `${upload.bucket}:${upload.key}:${upload.uploadId}`)),
	};
	blockers.pendingCleanupOutbox = {
		count: snapshot.cleanupTasks.length,
		samples: samples(snapshot.cleanupTasks.map((task) => `${task.kind}:${task.id}:${task.state}`)),
	};

	const requiredObjects = new Map<string, RequiredObject>();
	const metadataMismatchDetails = new Map<string, Set<string>>();
	const addMetadataMismatch = (bucket: string, key: string, detail: string) => {
		const identity = `${bucket}\0${key}`;
		const details = metadataMismatchDetails.get(identity) ?? new Set<string>();
		details.add(detail);
		metadataMismatchDetails.set(identity, details);
	};
	const addRequiredObject = (object: RequiredObject) => {
		const identity = `${object.bucket}\0${object.key}`;
		const existing = requiredObjects.get(identity);
		if (!existing) {
			requiredObjects.set(identity, object);
			return;
		}
		for (const owner of object.owners) existing.owners.add(owner);
		for (const candidate of object.expectations) {
			if (existing.expectations.some((current) => expectedMetadataConflicts(current.metadata, candidate.metadata))) {
				addMetadataMismatch(object.bucket, object.key, 'canonical-metadata-conflict');
				for (const owner of existing.owners) unresolvedRowIdentities.add(owner);
			}
			existing.expectations.push(candidate);
		}
	};
	for (const representation of allRepresentations) {
		if (representation.state === 'READY' && representation.bucket && representation.objectKey) {
			addRequiredObject({
				bucket: representation.bucket,
				key: representation.objectKey,
				expectations: [{
					owner: `asset:${representation.assetId}`,
					requireIdentity: true,
					metadata: {
					sizeBytes: representation.sizeBytes,
					mimeType: representation.mimeType,
					checksumSha256: representation.checksumAlgorithm?.toUpperCase() === 'SHA256'
						? representation.checksum : null,
					etag: representation.etag,
					sourceIdentityAlgorithm: representation.sourceIdentityAlgorithm,
					sourceIdentity: representation.sourceIdentity,
				},
				}],
				owners: new Set([`asset:${representation.assetId}`]),
			});
		}
	}
	for (const relocation of snapshot.relocations) {
		if (relocation.state !== 'COMMITTED' || !relocation.checksumSha256) continue;
		const owner = `relocation-source:${relocation.sourceBucket}:${relocation.sourceObjectKey}`;
		addRequiredObject({
			bucket: relocation.sourceBucket,
			key: relocation.sourceObjectKey,
			expectations: [{
				owner,
				requireIdentity: false,
				metadata: {
					sizeBytes: relocation.sizeBytes,
					mimeType: relocation.mimeType,
					checksumSha256: null,
					etag: null,
					sourceIdentityAlgorithm: null,
					sourceIdentity: null,
				},
			}],
			owners: new Set([owner]),
		});
	}
	for (const deployment of readyDeployments) {
		const manifest = manifestObjects(deployment.objectManifest);
		if (deployment.publicBucket && manifest) {
			for (const object of manifest) {
				addRequiredObject({
					bucket: deployment.publicBucket,
					key: object.objectKey,
					expectations: [{
						owner: `deployment:${deployment.id}`,
						requireIdentity: true,
						metadata: {
						sizeBytes: object.sizeBytes,
						mimeType: object.mimeType,
						checksumSha256: object.checksumSha256,
						etag: object.etag,
						sourceIdentityAlgorithm: null,
						sourceIdentity: null,
					},
					}],
					owners: new Set([`deployment:${deployment.id}`]),
				});
			}
		}
	}
	const duplicateCanonicalObjects = [...requiredObjects.entries()].filter(([, object]) => object.owners.size > 1);
	for (const [, object] of duplicateCanonicalObjects) {
		for (const owner of object.owners) unresolvedRowIdentities.add(owner);
	}
	blockers.duplicateCanonicalOwnership = {
		count: duplicateCanonicalObjects.length,
		samples: samples(duplicateCanonicalObjects.map(([identity, object]) => (
			`${identity.replace('\0', ':')}:owners=${[...object.owners].sort().join(',')}`
		))),
	};
	const inventoryKeys = new Set(input.inventory.objects.map((object) => `${object.bucket}\0${object.key}`));
	const headResults = await mapBounded([...requiredObjects.values()], options.batchSize ?? 20, async (object) => {
		const controller = new AbortController();
		try {
			return await timeout(input.head(object.bucket, object.key, controller.signal), options.headTimeoutMs ?? 5_000, controller);
		} catch (error) {
			throw new Error(`Garage HEAD operational failure for ${object.bucket}/${object.key}: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
	const requiredObjectValues = [...requiredObjects.values()];
	const missing = requiredObjectValues.filter((object, index) => (
		!inventoryKeys.has(`${object.bucket}\0${object.key}`) || headResults[index] === null
	));
	for (const object of missing) for (const owner of object.owners) unresolvedRowIdentities.add(owner);
	blockers.missingObjects = { count: missing.length, samples: samples(missing.map((object) => `${object.bucket}:${object.key}`)) };
	const matchingHead = new Set<string>();
	for (const [index, object] of requiredObjectValues.entries()) {
		const actual = headResults[index];
		if (!actual) continue;
		let matchesEveryExpectation = true;
		for (const expectation of object.expectations) {
			const mismatches = metadataMismatches(expectation.metadata, actual)
				.filter((mismatch) => expectation.requireIdentity || mismatch !== 'identity-unverifiable');
			if (mismatches.length === 0) continue;
			matchesEveryExpectation = false;
			for (const mismatch of mismatches) addMetadataMismatch(object.bucket, object.key, mismatch);
			unresolvedRowIdentities.add(expectation.owner);
		}
		if (matchesEveryExpectation && inventoryKeys.has(`${object.bucket}\0${object.key}`)) {
			matchingHead.add(`${object.bucket}\0${object.key}`);
		}
	}
	blockers.objectMetadataMismatches = {
		count: metadataMismatchDetails.size,
		samples: samples([...metadataMismatchDetails.entries()].map(([identity, details]) => (
			`${identity.replace('\0', ':')}:${[...details].sort().join(',')}`
		))),
	};

	const exactOwned = new Set(requiredObjects.keys());
	const relocationSourceIdentities = new Set(snapshot.relocations
		.filter((relocation) => relocation.state === 'COMMITTED')
		.map((relocation) => `${relocation.sourceBucket}\0${relocation.sourceObjectKey}`));
	const unknown = input.inventory.objects.filter((object) => (
		!exactOwned.has(`${object.bucket}\0${object.key}`)
	));
	blockers.unknownInventoryOwnership = { count: unknown.length, samples: samples(unknown.map((object) => `${object.bucket}:${object.key}`)) };

	const blockerCount = BLOCKERS.reduce((total, name) => total + blockers[name].count, 0);
	return {
		version: 2,
		startedAt: started.toISOString(),
		finishedAt: (input.now ?? (() => new Date()))().toISOString(),
		inventorySnapshot: { identity: input.inventory.identity, capturedAt: input.inventory.capturedAt, objectCount: input.inventory.objects.length },
		counts: {
			legacyRowsTotal: snapshot.assets.filter((asset) => asset.storageKey !== null || asset.playbackStorageKey !== null).length
				+ snapshot.exhibitions.filter((exhibition) => exhibition.posterStorageKey !== null).length
				+ snapshot.projects.filter((project) => project.webglEntryKey.length > 0).length,
			legacyRowsTerminal: terminalAssets.filter((asset) => asset.storageKey !== null || asset.playbackStorageKey !== null).length,
			backfilledCanonicalRows: snapshot.assets.filter((asset) => asset.representations.length > 0).length
				+ snapshot.deployments.length,
			verifiedCanonicalObjects: [...matchingHead].filter((identity) => !relocationSourceIdentities.has(identity)).length,
			verifiedRelocationSources: [...matchingHead].filter((identity) => relocationSourceIdentities.has(identity)).length,
			physicalCopies: allRepresentations.filter(({ sourceIdentityAlgorithm, state }) => (
				state === 'READY' && sourceIdentityAlgorithm === 'MIGRATION_COPY_SHA256'
			)).length,
			generatedRenditions: allRepresentations.filter(({ sourceIdentityAlgorithm, state }) => (
				state === 'READY' && sourceIdentityAlgorithm === 'MIGRATION_GENERATED_SHA256'
			)).length,
			unresolvedRows: unresolvedRowIdentities.size,
			orphanObjects: blockers.unknownInventoryOwnership.count,
			duplicateOwnership: blockers.duplicateCanonicalOwnership.count,
			legacyFallbackReads: Number(fallbackReads),
		},
		blockers,
		clean: blockerCount === 0,
		metricObservationReset: !!options.resetObservation,
	};
}
