// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
import { cn } from '@videojs/utils/style';
import type { ComponentProps } from 'react';

/** Shared button carrying the base interactive styles used by media controls. */
export type ButtonProps = ComponentProps<'button'>;

export function Button({ className, ...props }: ButtonProps) {
  return <button className={cn('media-button', className)} {...props} />;
}
