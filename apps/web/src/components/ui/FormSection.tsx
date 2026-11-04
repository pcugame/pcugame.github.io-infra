import type { ComponentPropsWithRef, ReactNode } from 'react';

export type FormSectionProps = ComponentPropsWithRef<'fieldset'> & {
  legend: ReactNode;
  variant?: 'panel' | 'plain';
};

export function FormSection({ legend, variant = 'panel', className, children, ...props }: FormSectionProps) {
  return (
    <fieldset {...props} className={['form-section', `form-section--${variant}`, className].filter(Boolean).join(' ')}>
      <legend>{legend}</legend>
      {children}
    </fieldset>
  );
}
