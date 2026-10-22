// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
/** @jsxImportSource react */

import { cn } from '@videojs/utils/style';
import type { ComponentProps } from 'react';

import { StatusAnnouncer } from '../../../../../shared/components/behaviors/status-announcer';
import { SeekIndicator } from '../../../../components/display/seek-indicator';
import { PlaybackStatusIndicator, StatusIndicator } from '../../../../components/display/status-indicator';
import { VolumeIndicator } from '../../../../components/display/volume-indicator';

export type VideoStatusIndicatorsProps = Omit<ComponentProps<'div'>, 'children'>;

export function VideoStatusIndicators({ className, ...props }: VideoStatusIndicatorsProps = {}) {
  return (
    <>
      <StatusAnnouncer />
      <div className={cn('video-status-indicators', className)} {...props}>
        <VolumeIndicator />
        <StatusIndicator />
        <SeekIndicator />
        <PlaybackStatusIndicator />
      </div>
    </>
  );
}
