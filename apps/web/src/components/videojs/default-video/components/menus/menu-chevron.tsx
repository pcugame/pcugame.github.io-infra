// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
/** @jsxImportSource react */

import { cn } from '@videojs/utils/style';

import { ChevronIcon as ChevronIconPrimitive } from '@videojs/react/icons';
import type { ClassValue } from '@videojs/utils/style';

export interface MenuChevronProps {
  back?: boolean;
  className?: ClassValue;
}

export function MenuChevron({ back = false, className }: MenuChevronProps = {}) {
  return (
    <ChevronIconPrimitive className={cn(back ? 'media-menu-back-chevron' : 'media-menu-forward-chevron', className)} />
  );
}
