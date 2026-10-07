import type { ComponentPropsWithRef } from 'react';

/** Native form semantics with progressively enhanced shared picker styles. */
export function SelectControl({ className, ...props }: ComponentPropsWithRef<'select'>) {
  return <select {...props} className={['form-control', className].filter(Boolean).join(' ')} />;
}
