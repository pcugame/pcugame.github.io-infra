export function videoPlaybackObjectKey(input: {
	id: string;
	projectId: number;
	generation: number;
}): string {
	const safeSession = Buffer.from(input.id, 'utf8').toString('base64url');
	return `protected/assets/video/${input.projectId}/${safeSession}/g${input.generation}/playback.mp4`;
}
