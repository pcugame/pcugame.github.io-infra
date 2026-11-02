import { parseVideoPlaybackRenditionKey } from '@pcu/contracts';
export interface PlaybackJobView {
	id: string;
	state: string;
	active: boolean;
	error: string | null;
	renditions: { profile: string; state: string; frameRate: number | null; width: number | null; height: number | null; expiresAt: Date | null }[];
}
export function videoPlaybackFields(asset: { id: number; playbackJobs?: PlaybackJobView[] }, basePlaybackUrl: string) {
	const active = asset.playbackJobs?.find(job => job.active);
	const latest = asset.playbackJobs?.[0];
	return {
		...(active ? {
			playbacks: active.renditions.flatMap(r => {
				const selection = parseVideoPlaybackRenditionKey(r.profile);
				if (!selection || r.state !== 'READY' || r.expiresAt !== null) return [];
				return [{ ...selection,
				    url: `${basePlaybackUrl}&profile=${selection.profile}${selection.quality === 'max' ? '' : `&quality=${selection.quality}`}`,
				    mimeType: 'video/mp4', frameRate: r.frameRate!, width: r.width!, height: r.height!, status: 'READY' as const,
				}];
			}).sort((a, b) => b.height - a.height || b.width - a.width || b.frameRate - a.frameRate)
		} : {}),
		...(latest ? {
			playbackJob: {
				id: latest.id, status: latest.state as 'PENDING' | 'RUNNING' | 'READY' | 'FAILED',
				...(latest.error ? { error: latest.error } : {})
			}
		} : {}),
	};
}
