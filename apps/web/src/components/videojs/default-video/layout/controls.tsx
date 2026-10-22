// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
/** @jsxImportSource react */

import { cn } from '@videojs/utils/style';
import type { ComponentProps, ReactNode } from 'react';

import { Controls, Time, Tooltip } from '@videojs/react';
import { ButtonTooltip } from '../../shared/components/buttons/button-tooltip';
import { AirPlayButton } from '../components/buttons/airplay-button';
import { CaptionsButton } from '../components/buttons/captions-button';
import { CastButton } from '../components/buttons/cast-button';
import { FullscreenButton } from '../components/buttons/fullscreen-button';
import { PiPButton } from '../components/buttons/pip-button';
import { PlayButton } from '../components/buttons/play-button';
import { VolumePopover } from '../components/menus/volume-popover';
import { TimeSlider } from '../components/sliders/time-slider';
import { VideoSettingsMenu } from '../skins/shared/video/menus/settings-menu';

export interface DefaultVideoControlsProps {
  settingsMenuItems?: ReactNode;
  renderThumbnail?: NonNullable<ComponentProps<typeof TimeSlider>>['renderThumbnail'];
}

export function DefaultVideoControls({ renderThumbnail, settingsMenuItems }: DefaultVideoControlsProps = {}) {
  return (
    <Controls.Root>
      <Controls.Backdrop className={'video-controls-backdrop'} />
      <Controls.Content className={cn('video-controls', 'video-controls-content')}>
        <Tooltip.Provider>
          <Controls.Group className={'video-controls-primary'}>
            <ButtonTooltip side="top">
              <PlayButton />
            </ButtonTooltip>
            <VolumePopover className={'video-controls-volume-button'} />

            <Controls.Group className={'video-time-slider-group'}>
              <Time.Value className={cn('media-time-value', 'video-time-value')} type="current" />
              <TimeSlider renderThumbnail={renderThumbnail} />
              <Time.Value className={cn('media-time-toggle', 'video-time-value')} type="remaining" toggle />
            </Controls.Group>

            <ButtonTooltip side="top">
              <CaptionsButton className={'video-controls-captions-button'} />
            </ButtonTooltip>
            <VideoSettingsMenu className={'video-controls-settings-button'}>{settingsMenuItems}</VideoSettingsMenu>
          </Controls.Group>

          <Controls.Group className={'video-controls-secondary'}>
            <ButtonTooltip side="top">
              <CastButton />
            </ButtonTooltip>
            <ButtonTooltip side="top">
              <AirPlayButton />
            </ButtonTooltip>
            <ButtonTooltip side="top">
              <PiPButton />
            </ButtonTooltip>
            <ButtonTooltip side="top">
              <FullscreenButton />
            </ButtonTooltip>
          </Controls.Group>
        </Tooltip.Provider>
      </Controls.Content>
    </Controls.Root>
  );
}
