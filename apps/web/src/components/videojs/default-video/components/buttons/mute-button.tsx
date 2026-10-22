// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
/** @jsxImportSource react */

import { cn } from '@videojs/utils/style';
import { resolveClassName } from '@videojs/utils/style';

import {
  VolumeOffIcon as VolumeOffIconPrimitive,
  VolumeLowIcon as VolumeLowIconPrimitive,
  VolumeHighIcon as VolumeHighIconPrimitive,
} from '@videojs/react/icons';
import { MuteButton as MuteButtonPrimitive } from '@videojs/react';
import { Button } from '../../../shared/components/buttons/button';

export type MuteButtonProps = Omit<MuteButtonPrimitive.Props, 'children'>;

export function MuteButton({ className, ...props }: MuteButtonProps = {}) {
  return (
    <MuteButtonPrimitive
      render={<Button />}
      className={(state) => cn('media-mute-button', resolveClassName(className, state))}
      {...props}
    >
      <VolumeOffIconPrimitive className={cn('media-button-icon', 'media-mute-button-off-icon')} />
      <VolumeLowIconPrimitive className={cn('media-button-icon', 'media-mute-button-low-icon')} />
      <VolumeHighIconPrimitive className={cn('media-button-icon', 'media-mute-button-high-icon')} />
    </MuteButtonPrimitive>
  );
}
