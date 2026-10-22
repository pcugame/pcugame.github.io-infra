// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
/** @jsxImportSource react */

import { cn } from '@videojs/utils/style';
import { resolveClassName } from '@videojs/utils/style';

import { Title as TitlePrimitive } from '@videojs/react';

export type TitleProps = Omit<TitlePrimitive.Props, 'children'>;

export function Title({ className, ...props }: TitleProps = {}) {
  return <TitlePrimitive className={(state) => cn('media-title', resolveClassName(className, state))} {...props} />;
}
