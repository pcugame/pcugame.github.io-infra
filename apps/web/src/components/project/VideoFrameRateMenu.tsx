import type { ProjectVideo } from '@pcu/contracts';
import { VideoPlaybackMenu } from './VideoPlaybackMenu';

interface Props {
	options: NonNullable<ProjectVideo['playbacks']>;
	value: string;
	onValueChange: (value: string) => void;
}

export function VideoFrameRateMenu({ options, value, onValueChange }: Props) {
	return <VideoPlaybackMenu label="프레임률" value={value} onValueChange={onValueChange} items={options.map(item => ({
		value: item.profile,
		label: `${item.profile === 'native' ? '원본 프레임률 · ' : ''}${Number(item.frameRate.toFixed(3))}fps`,
	}))} />;
}
