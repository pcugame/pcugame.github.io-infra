import type { ComponentPropsWithRef } from 'react';

export type ProgressBarProps = ComponentPropsWithRef<'progress'> & {
  size?: 'sm' | 'md';
  tone?: 'info' | 'success';
};

/** Omit value for native indeterminate progress; callers own progress calculation. */
export function ProgressBar({ size = 'md', tone = 'info', max = 100, className, ...props }: ProgressBarProps) {
  return <progress {...props} max={max} className={['progress-bar', `progress-bar--${size}`, `progress-bar--${tone}`, className].filter(Boolean).join(' ')} />;
}
