import { useId } from 'react';
import { SelectControl } from './SelectControl';
import type { ComponentPropsWithRef, ReactNode } from 'react';

type FieldContent = {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
};

type TextInputType = 'text' | 'search' | 'email' | 'password' | 'tel' | 'url' | 'number'
  | 'date' | 'datetime-local' | 'month' | 'time' | 'week';

export type TextFieldProps = Omit<ComponentPropsWithRef<'input'>, 'type'> & FieldContent & {
  type?: TextInputType;
};
export type SelectFieldProps = ComponentPropsWithRef<'select'> & FieldContent;
export type TextareaFieldProps = ComponentPropsWithRef<'textarea'> & FieldContent;
export type CheckboxFieldProps = Omit<ComponentPropsWithRef<'input'>, 'type'> & FieldContent;

function hasContent(content: ReactNode) {
  return content !== undefined && content !== null && content !== false && content !== '';
}

function useField(id: string | undefined, hint: ReactNode, error: ReactNode, describedBy: string | undefined) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const hintId = hasContent(hint) ? `${controlId}-hint` : undefined;
  const errorId = hasContent(error) ? `${controlId}-error` : undefined;
  return {
    controlId,
    hintId,
    errorId,
    describedBy: [describedBy, hintId, errorId].filter(Boolean).join(' ') || undefined,
  };
}

type FieldLayoutProps = FieldContent & {
  controlId: string;
  hintId?: string;
  errorId?: string;
  children: ReactNode;
  choice?: boolean;
};

function FieldLayout({ label, hint, error, controlId, hintId, errorId, children, choice }: FieldLayoutProps) {
  return (
    <div className="form-field">
      {choice ? (
        <label className="form-choice" htmlFor={controlId}>{children}<span>{label}</span></label>
      ) : (
        <><label className="form-field__label" htmlFor={controlId}>{label}</label>{children}</>
      )}
      {hintId && <p id={hintId} className="field-hint">{hint}</p>}
      {errorId && <p id={errorId} className="field-error" role="alert">{error}</p>}
    </div>
  );
}

export function TextField({ label, hint, error, id, className, type = 'text', 'aria-describedby': describedBy, 'aria-invalid': invalid, ...props }: TextFieldProps) {
  const field = useField(id, hint, error, describedBy);
  return (
    <FieldLayout {...field} label={label} hint={hint} error={error}>
      <input {...props} id={field.controlId} type={type} className={['form-control', className].filter(Boolean).join(' ')} aria-describedby={field.describedBy} aria-invalid={field.errorId ? true : invalid} />
    </FieldLayout>
  );
}

export function SelectField({ label, hint, error, id, className, 'aria-describedby': describedBy, 'aria-invalid': invalid, ...props }: SelectFieldProps) {
  const field = useField(id, hint, error, describedBy);
  return (
    <FieldLayout {...field} label={label} hint={hint} error={error}>
      <SelectControl {...props} id={field.controlId} className={className} aria-describedby={field.describedBy} aria-invalid={field.errorId ? true : invalid} />
    </FieldLayout>
  );
}

export function TextareaField({ label, hint, error, id, className, 'aria-describedby': describedBy, 'aria-invalid': invalid, ...props }: TextareaFieldProps) {
  const field = useField(id, hint, error, describedBy);
  return (
    <FieldLayout {...field} label={label} hint={hint} error={error}>
      <textarea {...props} id={field.controlId} className={['form-control', className].filter(Boolean).join(' ')} aria-describedby={field.describedBy} aria-invalid={field.errorId ? true : invalid} />
    </FieldLayout>
  );
}

export function CheckboxField({ label, hint, error, id, className, 'aria-describedby': describedBy, 'aria-invalid': invalid, ...props }: CheckboxFieldProps) {
  const field = useField(id, hint, error, describedBy);
  return (
    <FieldLayout {...field} label={label} hint={hint} error={error} choice>
      <input {...props} id={field.controlId} type="checkbox" className={className} aria-describedby={field.describedBy} aria-invalid={field.errorId ? true : invalid} />
    </FieldLayout>
  );
}
