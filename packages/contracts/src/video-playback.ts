export const VIDEO_PLAYBACK_QUALITIES = ['max', '720p'] as const;
export type VideoPlaybackQuality = typeof VIDEO_PLAYBACK_QUALITIES[number];
export type VideoPlaybackProfile = 'native' | 'cap60' | 'cap30';

export function videoPlaybackRenditionKey(profile: VideoPlaybackProfile, quality: VideoPlaybackQuality = 'max'): string {
 return quality === 'max' ? profile : `${profile}@${quality}`;
}

export function parseVideoPlaybackRenditionKey(key: string): { profile: VideoPlaybackProfile; quality: VideoPlaybackQuality } | null {
 const match = /^(native|cap60|cap30)(?:@(720p))?$/.exec(key);
 return match ? { profile: match[1] as VideoPlaybackProfile, quality: (match[2] ?? 'max') as VideoPlaybackQuality } : null;
}
