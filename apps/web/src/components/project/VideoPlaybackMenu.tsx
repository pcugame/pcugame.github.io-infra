import { Menu } from '@videojs/react';
import { SwitchesIcon } from '@videojs/react/icons';
import { MenuChevron } from '../videojs/default-video/components/menus/menu-chevron';
import { RadioItem } from '../videojs/default-video/components/menus/radio-item';

interface Props {
	label: string;
	items: { value: string; label: string }[];
	value: string;
	onValueChange: (value: string) => void;
}

// Explicit MP4 choices use the same library menu as speed and captions.
export function VideoPlaybackMenu({ label, items, value, onValueChange }: Props) {
	const selected = items.find(item => item.value === value);
	return <Menu.Root>
		<Menu.Trigger className="media-menu-trigger-item" aria-label={label}>
			<SwitchesIcon className="media-menu-trigger-item-icon" />{label}
			<span className="media-menu-hint"><span className="media-menu-hint-label">{selected?.label}</span><MenuChevron /></span>
		</Menu.Trigger>
		<Menu.Content className="media-menu-content">
			<Menu.Item className="media-menu-back-item"><MenuChevron back />{label}</Menu.Item>
			<Menu.Separator className="media-menu-separator" />
			<Menu.RadioGroup className="media-menu-radio-group" value={value} onValueChange={onValueChange}>
				{items.map(item => <RadioItem key={item.value} value={item.value}>{item.label}</RadioItem>)}
			</Menu.RadioGroup>
		</Menu.Content>
	</Menu.Root>;
}
