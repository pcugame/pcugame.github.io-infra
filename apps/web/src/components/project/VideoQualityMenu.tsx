import type { ProjectVideo, VideoPlaybackQuality } from '@pcu/contracts';
import { VideoPlaybackMenu } from './VideoPlaybackMenu';

interface Props {
	options: NonNullable<ProjectVideo['playbacks']>;
	value: VideoPlaybackQuality;
	onValueChange: (value: VideoPlaybackQuality) => void;
}

export function VideoQualityMenu({ options, value, onValueChange }: Props) {
	return <VideoPlaybackMenu label="화질" value={value}
		onValueChange={value => onValueChange(value as VideoPlaybackQuality)} items={options.map(item => ({
			value: item.quality ?? 'max',
			label: `${!item.quality || item.quality === 'max' ? '최고 · ' : ''}${item.height}p (${item.width}×${item.height})`,
		}))} />;
}
