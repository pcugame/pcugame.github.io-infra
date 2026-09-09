import type { UserRole } from '@pcu/contracts';

export type AssetDeliveryAction = 'DOWNLOAD_ORIGINAL' | 'DOWNLOAD_PLAYBACK';

export interface AssetDeliveryActor {
	id: number;
	role: UserRole;
}

export interface AssetDeliveryPolicyRecord {
	kind: string;
	project: {
		creatorId: number;
		status: string;
		members: { userId: number | null }[];
		changeRequestDraft?: {
			actorId: number;
			state: string;
			project: { creatorId: number; members: { userId: number | null }[] } | null;
		} | null;
	};
}

/** The sole authorization boundary before issuing protected object capabilities. */
export function authorizeAssetDelivery(input: {
	action: AssetDeliveryAction;
	asset: AssetDeliveryPolicyRecord;
	actor?: AssetDeliveryActor;
}): boolean {
	const { asset, actor } = input;
	const projectIsPublic = asset.project.status === 'PUBLISHED'
		|| asset.project.status === 'ARCHIVED';
	if (projectIsPublic && (asset.kind === 'GAME' || asset.kind === 'VIDEO' || asset.kind === 'DOCUMENT' || asset.kind === 'ATTACHMENT')) return true;

	if (!actor) return false;
	if (actor.role === 'ADMIN' || actor.role === 'OPERATOR') return true;
	const staging = asset.project.changeRequestDraft;
	if (staging) {
		const source = staging.project;
		return source !== null && ['DRAFT', 'PENDING', 'APPLYING', 'FAILED'].includes(staging.state)
			&& (source.creatorId === actor.id || source.members.some((member) => member.userId === actor.id));
	}
	if (asset.project.creatorId === actor.id) return true;
	return asset.project.members.some((member) => member.userId === actor.id);
}
