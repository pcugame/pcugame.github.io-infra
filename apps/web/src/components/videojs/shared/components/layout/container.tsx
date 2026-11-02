// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
/** @jsxImportSource react */

import { cn } from '@videojs/utils/style';

import { Container as ContainerPrimitive } from '@videojs/react';

export interface ContainerProps extends Omit<ContainerPrimitive.Props, 'children'> {
  children?: ContainerPrimitive.Props['children'];
}

export function Container({ children, className, ...props }: ContainerProps) {
  return (
    <ContainerPrimitive className={cn('media-skin', 'media-container', className)} {...props}>
      {children}
    </ContainerPrimitive>
  );
}
