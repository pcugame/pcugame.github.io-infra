// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
/** @jsxImportSource react */

import type { ComponentProps } from 'react';

import { AudioTrackMenu } from '../../../../components/menus/audio-track-menu';
import { CaptionsSubmenu } from '../../../../components/menus/captions-submenu';
import { PlaybackRateSubmenu } from '../../../../components/menus/playback-rate-submenu';
import { SettingsMenu } from '../../../../components/menus/settings-menu';

export type VideoSettingsMenuProps = NonNullable<ComponentProps<typeof SettingsMenu>>;

export function VideoSettingsMenu({ children, ...props }: VideoSettingsMenuProps = {}) {
  return (
    <SettingsMenu {...props}>
      {children}
      <AudioTrackMenu />
      <PlaybackRateSubmenu />
      <CaptionsSubmenu />
    </SettingsMenu>
  );
}
