// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
/** @jsxImportSource react */

import { cn } from '@videojs/utils/style';
import { resolveClassName } from '@videojs/utils/style';

import { Poster as PosterPrimitive } from '@videojs/react';

export interface PosterProps extends Omit<PosterPrimitive.ImageProps, 'children' | 'render'> {
  /** Draws the poster image in place of the one the skin renders. */
  renderImage?: PosterPrimitive.ImageProps['render'];

  children?: PosterPrimitive.RootProps['children'];
}

export function Poster({ children, className, renderImage, ...props }: PosterProps = {}) {
  return (
    <PosterPrimitive.Root className={(state) => cn('media-poster', resolveClassName(className, state))}>
      <PosterPrimitive.Image render={renderImage} className={'media-poster-image'} {...props} />

      {children}
    </PosterPrimitive.Root>
  );
}
