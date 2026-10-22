// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
/** @jsxImportSource react */

import { cn } from '@videojs/utils/style';
import { resolveClassName } from '@videojs/utils/style';

import { ChevronIcon as ChevronIconPrimitive } from '@videojs/react/icons';
import { SeekIndicator as SeekIndicatorPrimitive } from '@videojs/react';

export type SeekIndicatorProps = Omit<SeekIndicatorPrimitive.RootProps, 'children'>;

export function SeekIndicator({ className, ...props }: SeekIndicatorProps = {}) {
  return (
    <SeekIndicatorPrimitive.Root
      className={(state) => cn('media-seek-indicator', resolveClassName(className, state))}
      {...props}
    >
      <ChevronIconPrimitive className={'media-seek-indicator-icon'} />
      <SeekIndicatorPrimitive.Value className={'media-seek-indicator-value'} />
    </SeekIndicatorPrimitive.Root>
  );
}
