import type { UserRole } from '@pcu/contracts';

export type AssetDeliveryAction = 'DOWNLOAD_ORIGINAL' | 'DOWNLOAD_PLAYBACK';

export type AssetDeliveryActor = {
	id: number;
	role: UserRole;
};

export type AssetDeliveryPolicyRecord = {
	kind: string;
	project: {
		creatorId: number;
		status: string;
		members: { userId: number | null }[];
	};
};

/**
 * The single policy boundary for issuing protected object capabilities.
 * Published/archived GAME and VIDEO objects retain their public-download
 * behavior; all other deliveries require current project access.
 */
export function authorizeAssetAction(input: {
	action: AssetDeliveryAction;
	asset: AssetDeliveryPolicyRecord;
	actor?: AssetDeliveryActor;
}): boolean {
	const { asset, actor } = input;
	const publiclyDownloadable = (
		asset.project.status === 'PUBLISHED' || asset.project.status === 'ARCHIVED'
	) && (asset.kind === 'GAME' || asset.kind === 'VIDEO');
	if (publiclyDownloadable) return true;

	if (!actor) return false;
	if (actor.role === 'ADMIN' || actor.role === 'OPERATOR') return true;
	if (asset.project.creatorId === actor.id) return true;
	return asset.project.members.some((member) => member.userId === actor.id);
}
