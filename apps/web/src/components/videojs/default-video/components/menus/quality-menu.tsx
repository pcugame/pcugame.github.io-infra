// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
/** @jsxImportSource react */
import { qualityText } from '@videojs/core/i18n/text/menu';

import { SwitchesIcon as SwitchesIconPrimitive } from '@videojs/react/icons';
import { Menu } from '@videojs/react';
import { Text as TextPrimitive } from '@videojs/react';
import { QualityRadioGroup } from '@videojs/react';
import { MenuChevron } from './menu-chevron';
import { RadioItem } from './radio-item';

export type QualityMenuProps = Omit<Menu.RootProps, 'children'>;

export function QualityMenu({ ...props }: QualityMenuProps = {}) {
  return (
    <Menu.Root {...props}>
      <QualityRadioGroup.Root>
        <Menu.Trigger className={'media-menu-trigger-item'}>
          <SwitchesIconPrimitive className={'media-menu-trigger-item-icon'} />
          <TextPrimitive token={qualityText.key}>{qualityText.text}</TextPrimitive>
          <span className={'media-menu-hint'}>
            <QualityRadioGroup.Value className={'media-menu-hint-label'} />
            <MenuChevron />
          </span>
        </Menu.Trigger>
        <Menu.Content className={'media-menu-content'}>
          <Menu.Item className={'media-menu-back-item'}>
            <MenuChevron back />
            <TextPrimitive token={qualityText.key}>{qualityText.text}</TextPrimitive>
          </Menu.Item>
          <Menu.Separator className={'media-menu-separator'} />
          <QualityRadioGroup.Options
            className={'media-menu-radio-group'}
            renderItem={(props, item) => (
              <RadioItem {...props}>
                <span>
                  <span>{item.label}</span>
                  {item.tier ? <sup className={'media-menu-tier'}>{item.tier}</sup> : null}
                </span>
                {item.badge ? <span className={'media-menu-badge'}>{item.badge}</span> : null}
              </RadioItem>
            )}
          ></QualityRadioGroup.Options>
        </Menu.Content>
      </QualityRadioGroup.Root>
    </Menu.Root>
  );
}
