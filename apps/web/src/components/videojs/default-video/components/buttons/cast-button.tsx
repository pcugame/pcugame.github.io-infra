// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
/** @jsxImportSource react */

import { cn } from '@videojs/utils/style';
import { resolveClassName } from '@videojs/utils/style';

import {
  CastEnterIcon as CastEnterIconPrimitive,
  CastExitIcon as CastExitIconPrimitive,
} from '@videojs/react/icons';
import { CastButton as CastButtonPrimitive } from '@videojs/react';
import { Button } from '../../../shared/components/buttons/button';

export type CastButtonProps = Omit<CastButtonPrimitive.Props, 'children'>;

export function CastButton({ className, ...props }: CastButtonProps = {}) {
  return (
    <CastButtonPrimitive
      render={<Button />}
      className={(state) => cn('media-cast-button', resolveClassName(className, state))}
      {...props}
    >
      <CastEnterIconPrimitive className={cn('media-button-icon', 'media-cast-button-enter-icon')} />
      <CastExitIconPrimitive className={cn('media-button-icon', 'media-cast-button-exit-icon')} />
    </CastButtonPrimitive>
  );
}
