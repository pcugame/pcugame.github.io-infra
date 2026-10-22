// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
/** @jsxImportSource react */
import { audioText } from '@videojs/core/i18n/text/menu';

import { SpeechIcon as SpeechIconPrimitive } from '@videojs/react/icons';
import { Menu } from '@videojs/react';
import { Text as TextPrimitive } from '@videojs/react';
import { AudioTrackRadioGroup } from '@videojs/react';
import { MenuChevron } from './menu-chevron';
import { RadioItem } from './radio-item';

export type AudioTrackMenuProps = Omit<Menu.RootProps, 'children'>;

export function AudioTrackMenu({ ...props }: AudioTrackMenuProps = {}) {
  return (
    <Menu.Root {...props}>
      <AudioTrackRadioGroup.Root>
        <Menu.Trigger className={'media-menu-trigger-item'}>
          <SpeechIconPrimitive className={'media-menu-trigger-item-icon'} />
          <TextPrimitive token={audioText.key}>{audioText.text}</TextPrimitive>
          <span className={'media-menu-hint'}>
            <AudioTrackRadioGroup.Value className={'media-menu-hint-label'} />
            <MenuChevron />
          </span>
        </Menu.Trigger>
        <Menu.Content className={'media-menu-content'}>
          <Menu.Item className={'media-menu-back-item'}>
            <MenuChevron back />
            <TextPrimitive token={audioText.key}>{audioText.text}</TextPrimitive>
          </Menu.Item>
          <Menu.Separator className={'media-menu-separator'} />
          <AudioTrackRadioGroup.Options
            className={'media-menu-radio-group'}
            renderItem={(props, item) => (
              <RadioItem {...props}>
                <span>{item.label}</span>
              </RadioItem>
            )}
          ></AudioTrackRadioGroup.Options>
        </Menu.Content>
      </AudioTrackRadioGroup.Root>
    </Menu.Root>
  );
}
