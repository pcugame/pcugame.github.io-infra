// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
import { cn } from '@videojs/utils/style';
import type { ComponentProps } from 'react';

/** Shared slider track. */
export type SliderTrackProps = ComponentProps<'div'>;

export function SliderTrack({ className, ...props }: SliderTrackProps) {
  return <div className={cn('media-slider-track', className)} {...props} />;
}

/** Shared slider fill. */
export type SliderFillProps = ComponentProps<'div'>;

export function SliderFill({ className, ...props }: SliderFillProps) {
  return <div className={cn('media-slider-fill', className)} {...props} />;
}

/** Shared slider buffer. */
export type SliderBufferProps = ComponentProps<'div'>;

export function SliderBuffer({ className, ...props }: SliderBufferProps) {
  return <div className={cn('media-slider-buffer', className)} {...props} />;
}

/** Shared slider thumb. */
export type SliderThumbProps = ComponentProps<'div'>;

export function SliderThumb({ className, ...props }: SliderThumbProps) {
  return <div className={cn('media-slider-thumb', className)} {...props} />;
}
