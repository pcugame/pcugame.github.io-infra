// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
/** @jsxImportSource react */

import { cn } from '@videojs/utils/style';
import { resolveClassName } from '@videojs/utils/style';

import {
  RestartIcon as RestartIconPrimitive,
  PlayIcon as PlayIconPrimitive,
  PauseIcon as PauseIconPrimitive,
} from '@videojs/react/icons';
import { PlayButton as PlayButtonPrimitive } from '@videojs/react';
import { Button } from '../../../shared/components/buttons/button';

export type PlayButtonProps = Omit<PlayButtonPrimitive.Props, 'children'>;

export function PlayButton({ className, ...props }: PlayButtonProps = {}) {
  return (
    <PlayButtonPrimitive
      render={<Button />}
      className={(state) => cn('media-play-button', resolveClassName(className, state))}
      {...props}
    >
      <RestartIconPrimitive className={cn('media-button-icon', 'media-play-button-restart-icon')} />
      <PlayIconPrimitive className={cn('media-button-icon', 'media-play-button-play-icon')} />
      <PauseIconPrimitive className={cn('media-button-icon', 'media-play-button-pause-icon')} />
    </PlayButtonPrimitive>
  );
}
