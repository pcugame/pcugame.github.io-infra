// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
/** @jsxImportSource react */
import { captionsText } from '@videojs/core/i18n/text/menu';

import { CaptionsOffIcon as CaptionsOffIconPrimitive } from '@videojs/react/icons';
import { Menu } from '@videojs/react';
import { Text as TextPrimitive } from '@videojs/react';
import { CaptionsRadioGroup } from '@videojs/react';
import { MenuChevron } from './menu-chevron';
import { RadioItem } from './radio-item';

export type CaptionsSubmenuProps = Omit<Menu.RootProps, 'children'>;

export function CaptionsSubmenu({ ...props }: CaptionsSubmenuProps = {}) {
  return (
    <Menu.Root {...props}>
      <CaptionsRadioGroup.Root>
        <Menu.Trigger className={'media-menu-trigger-item'}>
          <CaptionsOffIconPrimitive className={'media-menu-trigger-item-icon'} />
          <TextPrimitive token={captionsText.key}>{captionsText.text}</TextPrimitive>
          <span className={'media-menu-hint'}>
            <CaptionsRadioGroup.Value className={'media-menu-hint-label'} />
            <MenuChevron />
          </span>
        </Menu.Trigger>
        <Menu.Content className={'media-menu-content'}>
          <Menu.Item className={'media-menu-back-item'}>
            <MenuChevron back />
            <TextPrimitive token={captionsText.key}>{captionsText.text}</TextPrimitive>
          </Menu.Item>
          <Menu.Separator className={'media-menu-separator'} />
          <CaptionsRadioGroup.Options
            className={'media-menu-radio-group'}
            renderItem={(props, item) => (
              <RadioItem {...props}>
                <span>{item.label}</span>
              </RadioItem>
            )}
          ></CaptionsRadioGroup.Options>
        </Menu.Content>
      </CaptionsRadioGroup.Root>
    </Menu.Root>
  );
}
