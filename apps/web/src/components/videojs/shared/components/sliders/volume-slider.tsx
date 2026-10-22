// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
/** @jsxImportSource react */

import { cn } from '@videojs/utils/style';
import { resolveClassName } from '@videojs/utils/style';

import { VolumeSlider as VolumeSliderPrimitive } from '@videojs/react';
import { SliderFill, SliderThumb, SliderTrack } from './slider';

export type VolumeSliderProps = Omit<VolumeSliderPrimitive.RootProps, 'children'>;

export function VolumeSlider({ className, ...props }: VolumeSliderProps = {}) {
  return (
    <VolumeSliderPrimitive.Root
      className={(state) => cn('media-slider', 'media-volume-slider', resolveClassName(className, state))}
      thumbAlignment="edge"
      {...props}
    >
      <VolumeSliderPrimitive.Track render={<SliderTrack />}>
        <VolumeSliderPrimitive.Fill render={<SliderFill />} />
      </VolumeSliderPrimitive.Track>
      <VolumeSliderPrimitive.Thumb render={<SliderThumb />} className={'media-volume-slider-thumb'} />
    </VolumeSliderPrimitive.Root>
  );
}
