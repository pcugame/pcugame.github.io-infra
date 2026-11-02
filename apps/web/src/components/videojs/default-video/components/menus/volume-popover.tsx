// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
/** @jsxImportSource react */
import type { VolumeSliderProps as CoreVolumeSliderProps } from '@videojs/core';
import { cn } from '@videojs/utils/style';

import { VolumePopover as VolumePopoverPrimitive } from '@videojs/react';
import type { ClassValue } from '@videojs/utils/style';
import { ButtonTooltip } from '../../../shared/components/buttons/button-tooltip';
import { VolumeSlider } from '../../../shared/components/sliders/volume-slider';
import { MuteButton } from '../buttons/mute-button';

export interface VolumePopoverProps extends Omit<VolumePopoverPrimitive.RootProps, 'children'> {
  className?: ClassValue;
  orientation?: CoreVolumeSliderProps['orientation'];
  showTooltip?: boolean;
}

export function VolumePopover({
  className,
  showTooltip = false,
  side = 'top',
  orientation = 'vertical',
  ...props
}: VolumePopoverProps = {}) {
  return (
    <VolumePopoverPrimitive.Root openOnHover delay={200} closeDelay={100} side={side} {...props}>
      <ButtonTooltip delay={0} disabled={!showTooltip} sticky side="top">
        <VolumePopoverPrimitive.Trigger render={<MuteButton className={cn(className)} />} />
      </ButtonTooltip>
      <VolumePopoverPrimitive.Popup
        className={cn(
          'media-popup',
          'media-popup-safe-area',
          'media-popup-transition',
          'media-popup-surface',
          'media-volume-popover'
        )}
      >
        <VolumeSlider orientation={orientation} />
      </VolumePopoverPrimitive.Popup>
    </VolumePopoverPrimitive.Root>
  );
}
