// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
/** @jsxImportSource react */

import { cn } from '@videojs/utils/style';
import { resolveClassName } from '@videojs/utils/style';

import {
  FullscreenEnterIcon as FullscreenEnterIconPrimitive,
  FullscreenExitIcon as FullscreenExitIconPrimitive,
} from '@videojs/react/icons';
import { FullscreenButton as FullscreenButtonPrimitive } from '@videojs/react';
import { Button } from '../../../shared/components/buttons/button';

export type FullscreenButtonProps = Omit<FullscreenButtonPrimitive.Props, 'children'>;

export function FullscreenButton({ className, ...props }: FullscreenButtonProps = {}) {
  return (
    <FullscreenButtonPrimitive
      render={<Button />}
      className={(state) => cn('media-fullscreen-button', resolveClassName(className, state))}
      {...props}
    >
      <FullscreenEnterIconPrimitive className={cn('media-button-icon', 'media-fullscreen-button-enter-icon')} />
      <FullscreenExitIconPrimitive className={cn('media-button-icon', 'media-fullscreen-button-exit-icon')} />
    </FullscreenButtonPrimitive>
  );
}
