import type { ComponentPropsWithRef } from 'react';

export type DialogFrameProps = ComponentPropsWithRef<'dialog'> & {
  size?: 'sm' | 'md' | 'lg';
};

/** Presentation only: the caller owns showModal, dismissal and focus restoration. */
export function DialogFrame({ size = 'md', className, ...props }: DialogFrameProps) {
  return <dialog {...props} className={['dialog-frame', `dialog-frame--${size}`, className].filter(Boolean).join(' ')} />;
}

export function DialogHeader({ className, ...props }: ComponentPropsWithRef<'header'>) {
  return <header {...props} className={['dialog-frame__header', className].filter(Boolean).join(' ')} />;
}

export function DialogBody({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return <div {...props} className={['dialog-frame__body', className].filter(Boolean).join(' ')} />;
}

export function DialogFooter({ className, ...props }: ComponentPropsWithRef<'footer'>) {
  return <footer {...props} className={['dialog-frame__footer', className].filter(Boolean).join(' ')} />;
}
