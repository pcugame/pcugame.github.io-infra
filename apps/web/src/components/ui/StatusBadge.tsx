import type { ComponentPropsWithRef } from 'react';

export type StatusBadgeProps = ComponentPropsWithRef<'span'> & {
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  size?: 'sm' | 'md';
};

export function StatusBadge({ tone = 'neutral', size = 'md', className, ...props }: StatusBadgeProps) {
  return <span {...props} className={['status-badge', `status-badge--${tone}`, `status-badge--${size}`, className].filter(Boolean).join(' ')} />;
}
