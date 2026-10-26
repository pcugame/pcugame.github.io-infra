// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
/** @jsxImportSource react */

import { cn } from '@videojs/utils/style';
import type { ComponentProps, ReactNode } from 'react';

import { ErrorDialog } from '../shared/components/dialogs/error-dialog';
import { Poster } from '../shared/components/display/poster';
import { Title } from '../shared/components/display/title';
import { Container } from '../shared/components/layout/container';
import { VideoGestures } from '../shared/skins/shared/video/behaviors/gestures';
import { VideoHotkeys } from '../shared/skins/shared/video/behaviors/hotkeys';
import { BufferingIndicator } from './components/display/buffering-indicator';
import { PlayButton } from './components/buttons/play-button';
import { DefaultVideoControls } from './layout/controls';
import { VideoStatusIndicators } from './skins/shared/video/display/status-indicators';

export interface VideoSkinProps extends Omit<NonNullable<ComponentProps<typeof Container>>, 'children'> {
  children?: ReactNode;
  settingsMenuItems?: ReactNode;
  renderPoster?: NonNullable<ComponentProps<typeof Poster>>['renderImage'];
  renderThumbnail?: NonNullable<ComponentProps<typeof DefaultVideoControls>>['renderThumbnail'];
}

export function VideoSkin({ children, className, renderPoster, renderThumbnail, settingsMenuItems, ...props }: VideoSkinProps = {}) {
  return (
    <Container className={cn('video-skin', className)} data-theme="default" data-preset="video" {...props}>
      {children}
      <Poster renderImage={renderPoster} />
      <BufferingIndicator />
      <ErrorDialog />
      <Title />
      <PlayButton className="project-video__center-play" />

      <DefaultVideoControls renderThumbnail={renderThumbnail} settingsMenuItems={settingsMenuItems} />

      <VideoHotkeys />
      <VideoGestures />
      <VideoStatusIndicators />
    </Container>
  );
}
