// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
/** @jsxImportSource react */

import { cn } from '@videojs/utils/style';
import { resolveClassName } from '@videojs/utils/style';

import { StatusAnnouncer as StatusAnnouncerPrimitive } from '@videojs/react';

export type StatusAnnouncerProps = Omit<StatusAnnouncerPrimitive.Props, 'children'>;

export function StatusAnnouncer({ className, ...props }: StatusAnnouncerProps = {}) {
  return (
    <StatusAnnouncerPrimitive
      className={(state) => cn('media-status-announcer', resolveClassName(className, state))}
      {...props}
    />
  );
}
