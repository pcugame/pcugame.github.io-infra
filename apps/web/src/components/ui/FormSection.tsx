import type { ComponentPropsWithRef, ReactNode } from 'react';

export type FormSectionProps = ComponentPropsWithRef<'fieldset'> & {
  legend: ReactNode;
};

export function FormSection({ legend, className, children, ...props }: FormSectionProps) {
  return (
    <fieldset {...props} className={['form-section', className].filter(Boolean).join(' ')}>
      <legend>{legend}</legend>
      {children}
    </fieldset>
  );
}
