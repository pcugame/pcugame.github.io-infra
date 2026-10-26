// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
/** @jsxImportSource react */

import { settingsText } from '@videojs/core/i18n/text/menu';
import { cn } from '@videojs/utils/style';
import { resolveClassName } from '@videojs/utils/style';

import { GearIcon as GearIconPrimitive } from '@videojs/react/icons';
import { Menu } from '@videojs/react';
import type { ClassValue } from '@videojs/utils/style';
import { Text as TextPrimitive } from '@videojs/react';
import { Button } from '../../../shared/components/buttons/button';
import { ButtonTooltip } from '../../../shared/components/buttons/button-tooltip';

export interface SettingsMenuProps extends Omit<Menu.RootProps, 'children'> {
  className?: ClassValue;

  children?: Menu.ContentProps['children'];
}

export function SettingsMenu({ children, className, ...props }: SettingsMenuProps) {
  return (
    <Menu.Root side="top" align="end" boundary="viewport" {...props}>
      <ButtonTooltip label={<TextPrimitive token={settingsText.key}>{settingsText.text}</TextPrimitive>} side="top">
        <Menu.Trigger
          render={<Button />}
          className={(state) => cn('media-settings-menu-trigger', resolveClassName(className, state))}
        >
          <GearIconPrimitive className={cn('media-button-icon-base', 'media-settings-menu-trigger-icon')} />
          <TextPrimitive className={'media-settings-menu-trigger-label'} token={settingsText.key}>
            {settingsText.text}
          </TextPrimitive>
        </Menu.Trigger>
      </ButtonTooltip>
      <Menu.Popup
        keepMounted
        className={cn('media-popup', 'media-popup-surface', 'media-menu-popup', 'media-menu-resizable-popup')}
      >
        <Menu.Content className={'media-menu-content'}>{children}</Menu.Content>
      </Menu.Popup>
    </Menu.Root>
  );
}
