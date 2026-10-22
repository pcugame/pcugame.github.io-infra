// Adapted from Video.js 10.1.0 (Apache-2.0); see public/licenses/videojs.txt.
/** @jsxImportSource react */

import { ErrorDialog as ErrorDialogPrimitive } from '@videojs/react';
import { Button } from '../buttons/button';

export function ErrorDialog() {
  return (
    <ErrorDialogPrimitive.Root>
      <ErrorDialogPrimitive.Backdrop className={'media-dialog-backdrop'} />
      <ErrorDialogPrimitive.Popup className={'media-dialog-popup'}>
        <div className={'media-dialog-content'}>
          <ErrorDialogPrimitive.Title className={'media-dialog-title'} />
          <ErrorDialogPrimitive.Description className={'media-dialog-description'} />
        </div>
        <div className={'media-dialog-actions'}>
          <ErrorDialogPrimitive.Close render={<Button />} className={'media-dialog-close'} />
        </div>
      </ErrorDialogPrimitive.Popup>
    </ErrorDialogPrimitive.Root>
  );
}
