import { assertWebglPublishedObjectManifest, type WebglPublishedObjectManifest } from '../webgl/manifest.js';
import { webglContentMetadata } from '../webgl/content.js';

export interface PublicationCopyObject {
	sourceBucket: string;
	sourceObjectKey: string;
	targetBucket: string;
	targetObjectKey: string;
	sizeBytes: string;
	checksumSha256: string;
	mimeType: string;
	contentEncoding: string | null;
	cacheControl: string;
}

export interface PublicationRepresentationCommit {
	id: string;
	assetId: number;
	role: 'ORIGINAL' | 'CARD_480' | 'DISPLAY_960';
	generation: number;
	sourceIdentityAlgorithm: string;
	sourceIdentity: string;
	sourceBucket: string;
	sourceObjectKey: string;
	targetBucket: string;
	targetObjectKey: string;
	sizeBytes: string;
	checksumSha256: string;
}

export interface PublicationWebglCommit {
	id: string;
	stagingBucket: string;
	stagingPrefix: string;
	publicBucket: string;
	publicPrefix: string;
	entryObjectKey: string;
	publicManifest: WebglPublishedObjectManifest;
}

export interface ProjectPublicationPlan {
	version: 1;
	projectId: number;
	submissionId: string;
	objects: PublicationCopyObject[];
	representations: PublicationRepresentationCommit[];
	webglDeployments: PublicationWebglCommit[];
}

export function createProjectPublicationPlan(input: {
	projectId: number;
	submissionId: string;
	protectedBucket: string;
	publicBucket: string;
	representations: Array<{
		id: string;
		assetId: number;
		role: 'ORIGINAL' | 'CARD_480' | 'DISPLAY_960';
		generation: number;
		sourceIdentityAlgorithm: string | null;
		sourceIdentity: string | null;
		bucket: string;
		objectKey: string;
		publicationBucket: string | null;
		publicationObjectKey: string | null;
		sizeBytes: bigint;
		checksumAlgorithm: string | null;
		checksum: string | null;
		mimeType: string;
	}>;
	webglDeployments: Array<{
		id: string;
		publicBucket: string;
		publicPrefix: string;
		entryObjectKey: string;
		stagingBucket: string | null;
		stagingPrefix: string | null;
		stagingEntryObjectKey: string | null;
		stagingObjectManifest: unknown;
	}>;
}): ProjectPublicationPlan {
	const objects: PublicationCopyObject[] = [];
	const representations: PublicationRepresentationCommit[] = [];
	for (const representation of input.representations) {
		if (representation.bucket !== input.protectedBucket
			|| representation.publicationBucket !== input.publicBucket
			|| !representation.publicationObjectKey
			|| representation.checksumAlgorithm !== 'SHA256'
			|| !representation.checksum || !/^[a-f0-9]{64}$/i.test(representation.checksum)
			|| !Number.isSafeInteger(representation.assetId) || representation.assetId < 1
			|| !['ORIGINAL', 'CARD_480', 'DISPLAY_960'].includes(representation.role)
			|| !Number.isSafeInteger(representation.generation) || representation.generation < 1
			|| !representation.sourceIdentityAlgorithm || !representation.sourceIdentity) {
			throw new Error('DRAFT image representation is not publication-staged');
		}
		const base = {
			sourceBucket: representation.bucket,
			sourceObjectKey: representation.objectKey,
			targetBucket: representation.publicationBucket,
			targetObjectKey: representation.publicationObjectKey,
			sizeBytes: String(representation.sizeBytes),
			checksumSha256: representation.checksum,
		};
		representations.push({
			id: representation.id,
			assetId: representation.assetId,
			role: representation.role,
			generation: representation.generation,
			sourceIdentityAlgorithm: representation.sourceIdentityAlgorithm,
			sourceIdentity: representation.sourceIdentity,
			...base,
		});
		objects.push({
			...base,
			mimeType: representation.mimeType,
			contentEncoding: null,
			cacheControl: 'public, max-age=31536000, immutable',
		});
	}

	const webglDeployments: PublicationWebglCommit[] = [];
	for (const deployment of input.webglDeployments) {
		if (deployment.publicBucket !== input.publicBucket || deployment.stagingBucket !== input.protectedBucket
			|| !deployment.stagingPrefix || !deployment.stagingEntryObjectKey) {
			throw new Error('DRAFT WebGL deployment is not publication-staged');
		}
		const stagingManifest = deployment.stagingObjectManifest as WebglPublishedObjectManifest;
		assertWebglPublishedObjectManifest(stagingManifest, deployment.stagingPrefix, deployment.stagingEntryObjectKey);
		const publicObjects = stagingManifest.objects.map((object) => {
			if (!object.checksumSha256) throw new Error('Staged WebGL object lacks SHA-256');
			const relativePath = object.objectKey.slice(deployment.stagingPrefix!.length);
			const targetObjectKey = `${deployment.publicPrefix}${relativePath}`;
			const metadata = webglContentMetadata(relativePath);
			objects.push({
				sourceBucket: deployment.stagingBucket!,
				sourceObjectKey: object.objectKey,
				targetBucket: deployment.publicBucket,
				targetObjectKey,
				sizeBytes: object.sizeBytes,
				checksumSha256: object.checksumSha256,
				mimeType: object.mimeType,
				contentEncoding: object.contentEncoding,
				cacheControl: metadata.cacheControl,
			});
			return { ...object, objectKey: targetObjectKey, etag: null };
		});
		const publicManifest: WebglPublishedObjectManifest = { version: 1, objects: publicObjects };
		assertWebglPublishedObjectManifest(publicManifest, deployment.publicPrefix, deployment.entryObjectKey);
		webglDeployments.push({
			id: deployment.id,
			stagingBucket: deployment.stagingBucket,
			stagingPrefix: deployment.stagingPrefix,
			publicBucket: deployment.publicBucket,
			publicPrefix: deployment.publicPrefix,
			entryObjectKey: deployment.entryObjectKey,
			publicManifest,
		});
	}

	return parseProjectPublicationPlan({
		version: 1,
		projectId: input.projectId,
		submissionId: input.submissionId,
		objects,
		representations,
		webglDeployments,
	});
}

function nonEmpty(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

export function parseProjectPublicationPlan(value: unknown): ProjectPublicationPlan {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Publication plan is missing');
	const plan = value as Partial<ProjectPublicationPlan>;
	if (plan.version !== 1 || !Number.isSafeInteger(plan.projectId) || (plan.projectId ?? 0) < 1
		|| !nonEmpty(plan.submissionId) || !Array.isArray(plan.objects)
		|| !Array.isArray(plan.representations) || !Array.isArray(plan.webglDeployments)) {
		throw new Error('Publication plan header is malformed');
	}
	const targetKeys = new Set<string>();
	const objectsByTarget = new Map<string, PublicationCopyObject>();
	for (const object of plan.objects) {
		if (!object || !nonEmpty(object.sourceBucket) || !nonEmpty(object.sourceObjectKey)
			|| !nonEmpty(object.targetBucket) || !nonEmpty(object.targetObjectKey)
			|| !/^\d+$/.test(object.sizeBytes) || BigInt(object.sizeBytes) < 0n
			|| !/^[a-f0-9]{64}$/i.test(object.checksumSha256) || !nonEmpty(object.mimeType)
			|| !(object.contentEncoding === null || object.contentEncoding === 'br' || object.contentEncoding === 'gzip')
			|| !nonEmpty(object.cacheControl)) throw new Error('Publication copy object is malformed');
		const identity = `${object.targetBucket}\0${object.targetObjectKey}`;
		if (targetKeys.has(identity)) throw new Error('Publication plan has duplicate target ownership');
		targetKeys.add(identity);
		objectsByTarget.set(identity, object);
	}
	const consumedTargets = new Set<string>();
	const representationIds = new Set<string>();
	for (const representation of plan.representations) {
		if (!representation || !nonEmpty(representation.id)
			|| !Number.isSafeInteger(representation.assetId) || representation.assetId < 1
			|| !['ORIGINAL', 'CARD_480', 'DISPLAY_960'].includes(representation.role)
			|| !Number.isSafeInteger(representation.generation) || representation.generation < 1
			|| !nonEmpty(representation.sourceIdentityAlgorithm) || !nonEmpty(representation.sourceIdentity)
			|| !nonEmpty(representation.sourceBucket) || !nonEmpty(representation.sourceObjectKey)
			|| !nonEmpty(representation.targetBucket) || !nonEmpty(representation.targetObjectKey)
			|| !/^\d+$/.test(representation.sizeBytes)
			|| !/^[a-f0-9]{64}$/i.test(representation.checksumSha256)) {
			throw new Error('Publication representation commit is malformed');
		}
		if (representationIds.has(representation.id)) throw new Error('Publication plan repeats a representation');
		representationIds.add(representation.id);
		const identity = `${representation.targetBucket}\0${representation.targetObjectKey}`;
		const copy = objectsByTarget.get(identity);
		if (!copy || copy.sourceBucket !== representation.sourceBucket
			|| copy.sourceObjectKey !== representation.sourceObjectKey
			|| copy.sizeBytes !== representation.sizeBytes
			|| copy.checksumSha256.toLowerCase() !== representation.checksumSha256.toLowerCase()) {
			throw new Error('Publication representation is not backed by its exact copy object');
		}
		consumedTargets.add(identity);
	}
	const deploymentIds = new Set<string>();
	for (const deployment of plan.webglDeployments) {
		if (!deployment || !nonEmpty(deployment.id) || !nonEmpty(deployment.stagingBucket)
			|| !nonEmpty(deployment.stagingPrefix) || !nonEmpty(deployment.publicBucket)
			|| !nonEmpty(deployment.publicPrefix) || !nonEmpty(deployment.entryObjectKey)
			|| !deployment.stagingPrefix.endsWith('/') || !deployment.publicPrefix.endsWith('/')) {
			throw new Error('Publication WebGL commit is malformed');
		}
		if (deploymentIds.has(deployment.id)) throw new Error('Publication plan repeats a WebGL deployment');
		deploymentIds.add(deployment.id);
		assertWebglPublishedObjectManifest(deployment.publicManifest, deployment.publicPrefix, deployment.entryObjectKey);
		if (deployment.publicManifest.objects.some((object) => object.checksumSha256 === null)) {
			throw new Error('Publication WebGL manifest lacks SHA-256');
		}
		for (const manifestObject of deployment.publicManifest.objects) {
			const identity = `${deployment.publicBucket}\0${manifestObject.objectKey}`;
			const copy = objectsByTarget.get(identity);
			const relativePath = manifestObject.objectKey.slice(deployment.publicPrefix.length);
			if (!copy || copy.sourceBucket !== deployment.stagingBucket
				|| copy.sourceObjectKey !== `${deployment.stagingPrefix}${relativePath}`
				|| copy.sizeBytes !== manifestObject.sizeBytes
				|| copy.checksumSha256.toLowerCase() !== manifestObject.checksumSha256!.toLowerCase()
				|| copy.mimeType !== manifestObject.mimeType
				|| copy.contentEncoding !== manifestObject.contentEncoding) {
				throw new Error('Publication WebGL manifest is not backed by its exact copy objects');
			}
			consumedTargets.add(identity);
		}
	}
	if (consumedTargets.size !== plan.objects.length) {
		throw new Error('Publication plan contains an unowned copy object');
	}
	return plan as ProjectPublicationPlan;
}

export function publicationCleanupTargets(plan: ProjectPublicationPlan) {
	return [
		...plan.objects.map((object) => ({
			bucket: object.targetBucket,
			storageKey: object.targetObjectKey,
			reason: 'project-publication-cancelled-target',
		})),
		...plan.webglDeployments.map((deployment) => ({
			bucket: deployment.stagingBucket,
			storageKey: deployment.stagingPrefix,
			targetKind: 'PREFIX' as const,
			reason: 'project-publication-staging-cleanup',
		})),
		...plan.representations.map((representation) => ({
			bucket: representation.sourceBucket,
			storageKey: representation.sourceObjectKey,
			reason: 'project-publication-staging-cleanup',
		})),
	];
}
