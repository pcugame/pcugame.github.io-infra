import type { Prisma } from '../../generated/prisma/client.js';
import { createProjectPublicationPlan, type ProjectPublicationPlan } from './plan.js';

export async function rebuildProjectPublicationPlan(
	tx: Prisma.TransactionClient,
	input: { projectId: number; submissionId: string },
): Promise<ProjectPublicationPlan> {
	const [protectedBucket, publicBucket, items] = await Promise.all([
		tx.storageBucket.findUnique({ where: { visibility: 'PROTECTED' } }),
		tx.storageBucket.findUnique({ where: { visibility: 'PUBLIC' } }),
		tx.projectSubmissionItem.findMany({
			where: { submissionId: input.submissionId },
			orderBy: { id: 'asc' },
			include: {
				uploadSession: true,
				resultAsset: { include: { representations: { orderBy: { id: 'asc' } } } },
				resultRepresentation: true,
				resultWebglDeployment: true,
			},
		}),
	]);
	if (!protectedBucket || !publicBucket) throw new Error('canonical storage bucket registry is incomplete');
	const representations: Parameters<typeof createProjectPublicationPlan>[0]['representations'] = [];
	const webglDeployments: Parameters<typeof createProjectPublicationPlan>[0]['webglDeployments'] = [];
	for (const item of items) {
		const session = item.uploadSession;
		const asset = item.resultAsset;
		const source = item.resultRepresentation;
		if (!item.required || item.state !== 'READY' || !session || session.state !== 'READY'
			|| item.boundGeneration === null || session.generation !== item.boundGeneration
			|| session.resultAssetId !== item.resultAssetId
			|| session.resultRepresentationId !== item.resultRepresentationId
			|| !asset || asset.id !== item.resultAssetId || asset.projectId !== input.projectId
			|| asset.exhibitionId !== null || asset.kind !== item.kind || asset.status !== 'READY'
			|| !source || source.id !== item.resultRepresentationId || source.assetId !== asset.id
			|| source.state !== 'READY'
			|| source.role !== (item.kind === 'WEBGL' ? 'WEBGL_SOURCE' : 'ORIGINAL')
			|| source.sourceIdentityAlgorithm !== session.sourceIdentityAlgorithm
			|| source.sourceIdentity !== session.sourceIdentity) {
			throw new Error(`submission item ${item.id} lost its asset, generation, or source ownership fence`);
		}
		if (item.kind === 'IMAGE' || item.kind === 'POSTER') {
			const publicationRoles = new Set(['ORIGINAL', 'CARD_480', 'DISPLAY_960']);
			const imageRepresentations = asset.representations.filter((representation) => publicationRoles.has(representation.role));
			if (imageRepresentations.length !== 3 || new Set(imageRepresentations.map(({ role }) => role)).size !== 3) {
				throw new Error(`submission item ${item.id} lost an image publication role`);
			}
			for (const representation of imageRepresentations) {
				if (!['ORIGINAL', 'CARD_480', 'DISPLAY_960'].includes(representation.role)
					|| representation.state !== 'READY'
					|| representation.sourceIdentityAlgorithm !== session.sourceIdentityAlgorithm
					|| representation.sourceIdentity !== session.sourceIdentity) {
					throw new Error(`submission item ${item.id} image role lost its source fence`);
				}
				representations.push({
					...representation,
					role: representation.role as 'ORIGINAL' | 'CARD_480' | 'DISPLAY_960',
					generation: session.generation,
				});
			}
		}
		if (item.kind === 'WEBGL') {
			const deployment = item.resultWebglDeployment;
			if (!deployment || deployment.id !== item.resultWebglDeploymentId
				|| deployment.projectId !== input.projectId
				|| deployment.sourceRepresentationId !== source.id || deployment.state !== 'READY') {
				throw new Error(`submission item ${item.id} lost its WebGL deployment fence`);
			}
			webglDeployments.push(deployment);
		}
	}
	return createProjectPublicationPlan({
		projectId: input.projectId,
		submissionId: input.submissionId,
		protectedBucket: protectedBucket.bucket,
		publicBucket: publicBucket.bucket,
		representations,
		webglDeployments,
	});
}
