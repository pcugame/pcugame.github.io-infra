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
	| 'duplicateCanonicalOwnership'
	| 'malformedWebglDeployments'
	| 'legacyBridgeObservations'
	| 'playbackOrphans'
	| 'unknownInventoryOwnership'
	| 'activeLegacyUploadSessions';

export type ContractAssetRepresentation = {
	id: string;
	assetId: number;
	role: string;
	bucket: string;
	objectKey: string;
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
	state: string;
};

export type ContractProjectRow = {
	id: number;
	webglEntryKey: string;
	currentWebglDeploymentId: string | null;
	currentWebglDeployment: ContractWebglDeployment | null;
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

export type ContractPreflightSnapshot = {
	assets: ContractAssetRow[];
	exhibitions: ContractExhibitionRow[];
	projects: ContractProjectRow[];
	metrics: ContractMetric[];
	uploadSessions: ContractUploadSession[];
};

export type ContractInventoryObject = { bucket: string; key: string };
export type ContractInventorySnapshot = {
	identity: string;
	capturedAt: string;
	objects: ContractInventoryObject[];
};

export type ContractPreflightRepository = {
	readSnapshot(): Promise<ContractPreflightSnapshot>;
	resetLegacyBridgeObservations(observedAt: Date): Promise<void>;
};

export type ContractHead = (bucket: string, key: string, signal: AbortSignal) => Promise<boolean>;

export type ContractPreflightOptions = {
	batchSize?: number;
	headTimeoutMs?: number;
	resetObservation?: boolean;
	resetConfirmation?: string;
};

export type ContractPreflightReport = {
	version: 1;
	startedAt: string;
	finishedAt: string;
	inventorySnapshot: { identity: string; capturedAt: string; objectCount: number };
	counts: {
		legacyRows: number;
		backfilledRows: number;
		migratedObjects: number;
		unresolved: number;
		orphan: number;
		duplicateOwnership: number;
		fallbackReads: number;
		terminalAssetsExcluded: number;
	};
	blockers: Record<ContractPreflightBlocker, { count: number; samples: string[] }>;
	clean: boolean;
	metricObservationReset: boolean;
};

export const CONTRACT_PREFLIGHT_RESET_CONFIRMATION = 'RESET_LEGACY_BRIDGE_OBSERVATION';
const TERMINAL_ASSET_STATUSES = new Set(['DELETED', 'FAILED']);
const TERMINAL_UPLOAD_STATUSES = new Set(['COMPLETED', 'CANCELLED', 'FAILED', 'RESOLVED']);
const BLOCKERS: readonly ContractPreflightBlocker[] = [
	'legacyOnlyActiveAssets', 'unresolvedRepresentations', 'missingObjects',
	'duplicateCanonicalOwnership', 'malformedWebglDeployments', 'legacyBridgeObservations',
	'playbackOrphans', 'unknownInventoryOwnership', 'activeLegacyUploadSessions',
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

type ValidManifestObject = { objectKey: string };

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
		objects.push({ objectKey: object['objectKey'] });
	}
	return objects;
}

function deploymentIsMalformed(
	project: ContractProjectRow,
	representationById: ReadonlyMap<string, { representation: ContractAssetRepresentation; asset: ContractAssetRow }>,
): string | null {
	const deployment = project.currentWebglDeployment;
	if (project.currentWebglDeploymentId === null) {
		return project.webglEntryKey ? `project:${project.id}:legacy-pointer-without-deployment` : null;
	}
	if (!deployment || deployment.id !== project.currentWebglDeploymentId) return `project:${project.id}:dangling-current-pointer`;
	if (deployment.projectId !== project.id || deployment.state !== 'READY') return `deployment:${deployment.id}:project-or-state`;
	const source = representationById.get(deployment.sourceRepresentationId);
	if (!source) return `deployment:${deployment.id}:missing-source-representation`;
	if (source.representation.role !== 'WEBGL_SOURCE' || source.representation.state !== 'READY'
		|| source.asset.projectId !== project.id) return `deployment:${deployment.id}:invalid-source-ownership`;
	if (!deployment.publicBucket || !deployment.publicPrefix || !deployment.entryObjectKey
		|| !deployment.entryObjectKey.startsWith(deployment.publicPrefix)
		|| !deployment.publicPrefix.endsWith('/')) return `deployment:${deployment.id}:invalid-public-identity`;
	const manifest = manifestObjects(deployment.objectManifest);
	if (!manifest || manifest.some((object) => !object.objectKey.startsWith(deployment.publicPrefix))
		|| !manifest.some((object) => object.objectKey === deployment.entryObjectKey)) {
		return `deployment:${deployment.id}:invalid-object-manifest`;
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
	if (options.resetObservation && options.resetConfirmation !== CONTRACT_PREFLIGHT_RESET_CONFIRMATION) {
		throw new Error(`Observation reset requires --confirm-reset=${CONTRACT_PREFLIGHT_RESET_CONFIRMATION}`);
	}
	if (options.resetObservation) await input.repository.resetLegacyBridgeObservations(started);
	const snapshot = await input.repository.readSnapshot();
	const blockers = emptyBlockers();
	const activeAssets = snapshot.assets.filter(active);
	const terminalAssets = snapshot.assets.filter((asset) => !active(asset));
	const representations = activeAssets.flatMap((asset) => asset.representations.map((representation) => ({ ...representation, asset })));
	const assetById = new Map(snapshot.assets.map((asset) => [asset.id, asset]));
	const representationById = new Map(snapshot.assets.flatMap((asset) => asset.representations.map((representation) => (
		[representation.id, { representation, asset }] as const
	))));

	const legacyOnlyAssets = activeAssets.filter((asset) => (
		(asset.storageKey !== null || asset.playbackStorageKey !== null)
		&& !asset.representations.some((representation) => representation.role === expectedSourceRole(asset) && representation.state === 'READY')
	));
	const legacyOnlyExhibitions = snapshot.exhibitions.filter((exhibition) => (
		exhibition.posterStorageKey !== null && exhibition.posterAssetId === null
	));
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
	const missingRequiredRoles: string[] = [];
	for (const asset of activeAssets) {
		const requiredRoles = [expectedSourceRole(asset)];
		if (['IMAGE', 'POSTER', 'THUMBNAIL'].includes(asset.kind)) {
			if (asset.card480Height !== null) requiredRoles.push('CARD_480');
			if (asset.display960Height !== null) requiredRoles.push('DISPLAY_960');
		}
		for (const role of requiredRoles) {
			if (!asset.representations.some((representation) => representation.role === role && representation.state === 'READY')) {
				missingRequiredRoles.push(`asset:${asset.id}:missing-${role}`);
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
			continue;
		}
		for (const role of [
			'ORIGINAL',
			...(exhibition.posterCard480Height === null ? [] : ['CARD_480']),
			...(exhibition.posterDisplay960Height === null ? [] : ['DISPLAY_960']),
		]) {
			if (!poster.representations.some((representation) => representation.role === role && representation.state === 'READY')) {
				malformedExhibitionPointers.push(`exhibition:${exhibition.id}:missing-${role}`);
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

	const ownership = new Map<string, Set<number>>();
	for (const representation of representations) {
		if (!representation.bucket || !representation.objectKey) continue;
		const key = `${representation.bucket}\0${representation.objectKey}`;
		const owners = ownership.get(key) ?? new Set<number>();
		owners.add(representation.assetId);
		ownership.set(key, owners);
	}
	const duplicates = [...ownership.entries()].filter(([, owners]) => owners.size > 1);
	blockers.duplicateCanonicalOwnership = {
		count: duplicates.length,
		samples: samples(duplicates.map(([key, owners]) => `${key.replace('\0', ':')}:assets=${[...owners].sort().join(',')}`)),
	};

	const malformed = snapshot.projects.map((project) => deploymentIsMalformed(project, representationById)).filter((value): value is string => value !== null);
	blockers.malformedWebglDeployments = { count: malformed.length, samples: samples(malformed) };

	const bridgeMetrics = snapshot.metrics.filter((metric) => LEGACY_BRIDGE_METRIC_NAMES.includes(metric.name as typeof LEGACY_BRIDGE_METRIC_NAMES[number]) && metric.value > 0n);
	const fallbackReads = bridgeMetrics.reduce((total, metric) => total + metric.value, 0n);
	blockers.legacyBridgeObservations = {
		count: Number(fallbackReads),
		samples: samples(bridgeMetrics.map((metric) => `metric:${metric.name}:${metric.scope}=${metric.value}`)),
	};

	const playbackOrphans = activeAssets.filter((asset) => (
		asset.kind === 'VIDEO'
		&& asset.status === 'READY'
		&& (() => {
			const playback = asset.representations.find((representation) => representation.role === 'PLAYBACK' && representation.state === 'READY');
			return !playback || (asset.playbackStorageKey !== null && playback.objectKey !== asset.playbackStorageKey);
		})()
	));
	blockers.playbackOrphans = { count: playbackOrphans.length, samples: samples(playbackOrphans.map((asset) => `asset:${asset.id}`)) };

	const activeUploads = snapshot.uploadSessions.filter((session) => !TERMINAL_UPLOAD_STATUSES.has(session.status));
	blockers.activeLegacyUploadSessions = { count: activeUploads.length, samples: samples(activeUploads.map((session) => `session:${session.id}:${session.status}`)) };

	const requiredObjects = new Map<string, { bucket: string; key: string }>();
	for (const representation of representations) {
		if (representation.state === 'READY' && representation.bucket && representation.objectKey) {
			requiredObjects.set(`${representation.bucket}\0${representation.objectKey}`, { bucket: representation.bucket, key: representation.objectKey });
		}
	}
	for (const project of snapshot.projects) {
		const deployment = project.currentWebglDeployment;
		const manifest = deployment?.state === 'READY' ? manifestObjects(deployment.objectManifest) : null;
		if (deployment?.state === 'READY' && deployment.publicBucket && manifest) {
			for (const object of manifest) {
				requiredObjects.set(`${deployment.publicBucket}\0${object.objectKey}`, {
					bucket: deployment.publicBucket,
					key: object.objectKey,
				});
			}
		}
	}
	const inventoryKeys = new Set(input.inventory.objects.map((object) => `${object.bucket}\0${object.key}`));
	const headResults = await mapBounded([...requiredObjects.values()], options.batchSize ?? 20, async (object) => {
		const controller = new AbortController();
		try {
			return await timeout(input.head(object.bucket, object.key, controller.signal), options.headTimeoutMs ?? 5_000, controller);
		} catch (error) {
			throw new Error(`Garage HEAD operational failure for ${object.bucket}/${object.key}: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
	const missing = [...requiredObjects.values()].filter((object, index) => !inventoryKeys.has(`${object.bucket}\0${object.key}`) || !headResults[index]);
	blockers.missingObjects = { count: missing.length, samples: samples(missing.map((object) => `${object.bucket}:${object.key}`)) };

	const exactOwned = new Set(requiredObjects.keys());
	const unknown = input.inventory.objects.filter((object) => (
		!exactOwned.has(`${object.bucket}\0${object.key}`)
	));
	blockers.unknownInventoryOwnership = { count: unknown.length, samples: samples(unknown.map((object) => `${object.bucket}:${object.key}`)) };

	const blockerCount = BLOCKERS.reduce((total, name) => total + blockers[name].count, 0);
	return {
		version: 1,
		startedAt: started.toISOString(),
		finishedAt: (input.now ?? (() => new Date()))().toISOString(),
		inventorySnapshot: { identity: input.inventory.identity, capturedAt: input.inventory.capturedAt, objectCount: input.inventory.objects.length },
		counts: {
			legacyRows: activeAssets.filter((asset) => asset.storageKey !== null || asset.playbackStorageKey !== null).length
				+ snapshot.exhibitions.filter((exhibition) => exhibition.posterStorageKey !== null).length,
			backfilledRows: activeAssets.filter((asset) => asset.representations.length > 0).length
				+ snapshot.exhibitions.filter((exhibition) => exhibition.posterStorageKey !== null && exhibition.posterAssetId !== null).length,
			migratedObjects: requiredObjects.size,
			unresolved: blockers.unresolvedRepresentations.count + blockers.missingObjects.count + blockers.malformedWebglDeployments.count,
			orphan: blockers.playbackOrphans.count + blockers.unknownInventoryOwnership.count,
			duplicateOwnership: blockers.duplicateCanonicalOwnership.count,
			fallbackReads: Number(fallbackReads),
			terminalAssetsExcluded: terminalAssets.length,
		},
		blockers,
		clean: blockerCount === 0,
		metricObservationReset: !!options.resetObservation,
	};
}
