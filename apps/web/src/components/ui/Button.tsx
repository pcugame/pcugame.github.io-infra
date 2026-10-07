import type { ComponentPropsWithRef } from 'react';

export type ButtonProps = ComponentPropsWithRef<'button'> & {
  variant?: 'primary' | 'secondary' | 'danger';
  size?: 'small' | 'large';
};

export function Button({ variant = 'primary', size, className, type = 'button', ...props }: ButtonProps) {
  const classes = ['btn', `btn--${variant}`, size && `btn--${size}`, className].filter(Boolean).join(' ');
  return <button {...props} type={type} className={classes} />;
}
