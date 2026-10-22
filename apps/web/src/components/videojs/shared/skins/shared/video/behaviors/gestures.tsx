// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
/** @jsxImportSource react */

import { Gesture } from '@videojs/react';

export interface VideoGesturesProps {
  disabled?: boolean | undefined;
}

export function VideoGestures({ disabled = false }: VideoGesturesProps = {}) {
  return (
    <>
      <Gesture disabled={disabled} type="tap" action="togglePaused" pointer="mouse" region="center" />
      <Gesture disabled={disabled} type="tap" action="toggleControls" pointer="touch" />
      <Gesture disabled={disabled} type="doubletap" action="seekStep" region="left" />
      <Gesture disabled={disabled} type="doubletap" action="toggleFullscreen" region="center" />
      <Gesture disabled={disabled} type="doubletap" action="seekStep" region="right" />
    </>
  );
}
