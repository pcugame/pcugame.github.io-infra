// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
/** @jsxImportSource react */

import { cn } from '@videojs/utils/style';
import type { ReactElement, ReactNode } from 'react';

import { Tooltip } from '@videojs/react';

export interface ButtonTooltipProps extends Omit<Tooltip.RootProps, 'children'> {
  children: ReactElement;
  label?: ReactNode;
}

export function ButtonTooltip({ children, label, ...props }: ButtonTooltipProps) {
  return (
    <Tooltip.Root {...props}>
      <Tooltip.Trigger render={children} />
      <Tooltip.Popup
        className={cn(
          'media-popup',
          'media-popup-safe-area',
          'media-popup-transition',
          'media-popup-surface',
          'media-tooltip'
        )}
      >
        {label ?? <Tooltip.Label />}
        {!label && <Tooltip.Shortcut className={'media-tooltip-shortcut'} />}
      </Tooltip.Popup>
    </Tooltip.Root>
  );
}
