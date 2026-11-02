// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
/** @jsxImportSource react */

import { cn } from '@videojs/utils/style';
import { resolveClassName } from '@videojs/utils/style';

import { PipEnterIcon as PipEnterIconPrimitive, PipExitIcon as PipExitIconPrimitive } from '@videojs/react/icons';
import { PiPButton as PiPButtonPrimitive } from '@videojs/react';
import { Button } from '../../../shared/components/buttons/button';

export type PiPButtonProps = Omit<PiPButtonPrimitive.Props, 'children'>;

export function PiPButton({ className, ...props }: PiPButtonProps = {}) {
  return (
    <PiPButtonPrimitive
      render={<Button />}
      className={(state) => cn('media-pip-button', resolveClassName(className, state))}
      {...props}
    >
      <PipEnterIconPrimitive className={cn('media-button-icon', 'media-pip-button-enter-icon')} />
      <PipExitIconPrimitive className={cn('media-button-icon', 'media-pip-button-exit-icon')} />
    </PiPButtonPrimitive>
  );
}
