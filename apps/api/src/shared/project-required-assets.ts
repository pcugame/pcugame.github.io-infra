import type { AssetKind, ProjectRequiredAssets } from '@pcu/contracts';
import { isPosterUrlSafe } from './poster-validation.js';

type Representation = { role: string; state: string };

/** Assets supplied here are the project's READY assets, not upload history. */
export type RequiredAssetsSource = {
	id: number;
	assets: Array<{ kind: AssetKind; representations?: Representation[] }>;
	poster: { kind: AssetKind; status: string; representations?: Representation[] } | null;
	currentWebglDeploymentId?: string | null;
	currentWebglDeployment?: {
		id: string; projectId: number; state: string;
		publicBucket: string; publicPrefix: string; entryObjectKey: string;
	} | null;
	/** Newest first, retaining the latest session per kind/state. */
	assetUploads?: Array<{ kind: string; state: string }>;
	publicationJob?: {
		state: string;
		submission: { items: Array<{ kind: string; state: string }> };
	} | null;
};

export function projectRequiredAssets(project: RequiredAssetsSource, publicBucket?: string): ProjectRequiredAssets {
	const readyRepresentation = (asset: { representations?: Representation[] }, role: string) =>
		asset.representations?.some((rep) => rep.role === role && rep.state === 'READY') ?? false;
	const activeKinds = new Set(project.assetUploads?.filter((upload) =>
		['ALLOCATING', 'UPLOADING', 'COMPLETING', 'VERIFYING'].includes(upload.state),
	).map((upload) => upload.kind));
	const latestUploads = new Map<string, string>();
	for (const upload of project.assetUploads ?? []) {
		if (!latestUploads.has(upload.kind)) latestUploads.set(upload.kind, upload.state);
	}
	const failedKinds = new Set([...latestUploads].filter(([, state]) => state === 'REJECTED').map(([kind]) => kind));
	if (project.publicationJob?.state === 'FAILED') {
		for (const item of project.publicationJob.submission.items) {
			if (item.state === 'READY') failedKinds.add(item.kind);
		}
	}
	if (project.publicationJob && ['PENDING', 'PROCESSING'].includes(project.publicationJob.state)) {
		for (const item of project.publicationJob.submission.items) {
			if (item.state === 'READY') activeKinds.add(item.kind);
		}
	}
	const videos = project.assets.filter((asset) => asset.kind === 'VIDEO');
	const deployment = project.currentWebglDeployment;
	const nativeBuild = {
		ready: project.assets.some((asset) => asset.kind === 'GAME' && readyRepresentation(asset, 'ORIGINAL')),
		processing: activeKinds.has('GAME'),
		failed: failedKinds.has('GAME'),
	};
	const webBuild = {
		ready: !!deployment && deployment.id === project.currentWebglDeploymentId
			&& deployment.projectId === project.id && deployment.state === 'READY'
			&& deployment.publicBucket === publicBucket && deployment.entryObjectKey.startsWith(deployment.publicPrefix),
		processing: activeKinds.has('WEBGL'),
		failed: failedKinds.has('WEBGL'),
	};
	const video = {
		failed: failedKinds.has('VIDEO') || videos.some((asset) => asset.representations?.some((rep) => rep.role === 'PLAYBACK' && rep.state === 'FAILED')),
		ready: videos.some((asset) => readyRepresentation(asset, 'ORIGINAL') && readyRepresentation(asset, 'PLAYBACK')),
		processing: activeKinds.has('VIDEO') || videos.some((asset) => asset.representations?.some((rep) =>
			rep.role === 'PLAYBACK' && ['PENDING', 'VERIFYING'].includes(rep.state))),
	};
	const poster = {
		ready: isPosterUrlSafe(project.poster ? {
			...project.poster, hasReadyOriginal: readyRepresentation(project.poster, 'ORIGINAL'),
		} : null),
		processing: activeKinds.has('POSTER'),
		failed: failedKinds.has('POSTER'),
	};
	const items = [nativeBuild, webBuild, video, poster];
	const readyCount = items.filter((item) => item.ready).length;
	return { nativeBuild, webBuild, video, poster, readyCount, totalCount: 4, complete: readyCount === 4 };
}
