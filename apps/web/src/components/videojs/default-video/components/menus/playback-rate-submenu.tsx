// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
/** @jsxImportSource react */
import { speedText } from '@videojs/core/i18n/text/menu';

import { SpeedIcon as SpeedIconPrimitive } from '@videojs/react/icons';
import { Menu } from '@videojs/react';
import { Text as TextPrimitive } from '@videojs/react';
import { PlaybackRateRadioGroup } from '@videojs/react';
import { MenuChevron } from './menu-chevron';
import { RadioItem } from './radio-item';

export type PlaybackRateSubmenuProps = Omit<Menu.RootProps, 'children'>;

export function PlaybackRateSubmenu({ ...props }: PlaybackRateSubmenuProps = {}) {
  return (
    <Menu.Root {...props}>
      <PlaybackRateRadioGroup.Root>
        <Menu.Trigger className={'media-menu-trigger-item'}>
          <SpeedIconPrimitive className={'media-menu-trigger-item-icon'} />
          <TextPrimitive token={speedText.key}>{speedText.text}</TextPrimitive>
          <span className={'media-menu-hint'}>
            <PlaybackRateRadioGroup.Value className={'media-menu-hint-label'} />
            <MenuChevron />
          </span>
        </Menu.Trigger>
        <Menu.Content className={'media-menu-content'}>
          <Menu.Item className={'media-menu-back-item'}>
            <MenuChevron back />
            <TextPrimitive token={speedText.key}>{speedText.text}</TextPrimitive>
          </Menu.Item>
          <Menu.Separator className={'media-menu-separator'} />
          <PlaybackRateRadioGroup.Options
            className={'media-menu-radio-group'}
            renderItem={(props, item) => (
              <RadioItem {...props}>
                <span>{item.label}</span>
              </RadioItem>
            )}
          ></PlaybackRateRadioGroup.Options>
        </Menu.Content>
      </PlaybackRateRadioGroup.Root>
    </Menu.Root>
  );
}
