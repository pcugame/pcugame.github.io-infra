// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
/** @jsxImportSource react */

import { cn } from '@videojs/utils/style';
import { resolveClassName } from '@videojs/utils/style';

import { SpinnerIcon as SpinnerIconPrimitive } from '@videojs/react/icons';
import { BufferingIndicator as BufferingIndicatorPrimitive } from '@videojs/react';

export type BufferingIndicatorProps = Omit<BufferingIndicatorPrimitive.Props, 'children'>;

export function BufferingIndicator({ className, ...props }: BufferingIndicatorProps = {}) {
  return (
    <BufferingIndicatorPrimitive
      className={(state) => cn('media-buffering-indicator', resolveClassName(className, state))}
      {...props}
    >
      <SpinnerIconPrimitive className={'media-buffering-indicator-spinner-icon'} />
    </BufferingIndicatorPrimitive>
  );
}
