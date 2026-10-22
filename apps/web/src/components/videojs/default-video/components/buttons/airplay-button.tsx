// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
/** @jsxImportSource react */

import { cn } from '@videojs/utils/style';
import { resolveClassName } from '@videojs/utils/style';

import {
  AirPlayEnterIcon as AirPlayEnterIconPrimitive,
  AirPlayExitIcon as AirPlayExitIconPrimitive,
} from '@videojs/react/icons';
import { AirPlayButton as AirPlayButtonPrimitive } from '@videojs/react';
import { Button } from '../../../shared/components/buttons/button';

export type AirPlayButtonProps = Omit<AirPlayButtonPrimitive.Props, 'children'>;

export function AirPlayButton({ className, ...props }: AirPlayButtonProps = {}) {
  return (
    <AirPlayButtonPrimitive
      render={<Button />}
      className={(state) => cn('media-airplay-button', resolveClassName(className, state))}
      {...props}
    >
      <AirPlayEnterIconPrimitive className={cn('media-button-icon', 'media-airplay-button-enter-icon')} />
      <AirPlayExitIconPrimitive className={cn('media-button-icon', 'media-airplay-button-exit-icon')} />
    </AirPlayButtonPrimitive>
  );
}
