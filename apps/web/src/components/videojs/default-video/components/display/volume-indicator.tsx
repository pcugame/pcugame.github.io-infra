// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
/** @jsxImportSource react */

import { cn } from '@videojs/utils/style';
import { resolveClassName } from '@videojs/utils/style';

import {
  VolumeHighIcon as VolumeHighIconPrimitive,
  VolumeLowIcon as VolumeLowIconPrimitive,
  VolumeOffIcon as VolumeOffIconPrimitive,
} from '@videojs/react/icons';
import { VolumeIndicator as VolumeIndicatorPrimitive } from '@videojs/react';

export type VolumeIndicatorProps = Omit<VolumeIndicatorPrimitive.RootProps, 'children'>;

export function VolumeIndicator({ className, ...props }: VolumeIndicatorProps = {}) {
  return (
    <VolumeIndicatorPrimitive.Root
      className={(state) => cn('media-indicator', 'media-volume-indicator', resolveClassName(className, state))}
      {...props}
    >
      <VolumeIndicatorPrimitive.Fill className={cn('media-indicator-content', 'media-volume-indicator-fill')}>
        <VolumeHighIconPrimitive className={'media-volume-indicator-high-icon'} />
        <VolumeLowIconPrimitive className={'media-volume-indicator-low-icon'} />
        <VolumeOffIconPrimitive className={'media-volume-indicator-off-icon'} />
        <VolumeIndicatorPrimitive.Value className={'media-volume-indicator-value'} />
      </VolumeIndicatorPrimitive.Fill>
    </VolumeIndicatorPrimitive.Root>
  );
}
