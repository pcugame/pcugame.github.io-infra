// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
/** @jsxImportSource react */

import { cn } from '@videojs/utils/style';
import { resolveClassName } from '@videojs/utils/style';

import { CheckIcon as CheckIconPrimitive } from '@videojs/react/icons';
import { Menu } from '@videojs/react';

export interface RadioItemProps extends Omit<Menu.RadioItemProps, 'children'> {
  children?: Menu.RadioItemProps['children'];
}

export function RadioItem({ children, className, ...props }: RadioItemProps) {
  return (
    <Menu.RadioItem className={(state) => cn('media-menu-radio-item', resolveClassName(className, state))} {...props}>
      {children}
      <Menu.ItemIndicator forceMount className={'media-menu-item-indicator'}>
        <CheckIconPrimitive className={'media-menu-radio-item-icon'} />
      </Menu.ItemIndicator>
    </Menu.RadioItem>
  );
}
