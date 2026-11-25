import { useId } from 'react';
import { SelectControl } from './SelectControl';
import { FieldHelp } from './FieldHelp';
import type { ComponentPropsWithRef, ReactNode } from 'react';

type FieldContent = {
  label: ReactNode;
  hint?: ReactNode;
  help?: string;
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

function useField(id: string | undefined, hint: ReactNode, error: ReactNode, describedBy: string | undefined, help?: string) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const hintId = hasContent(hint) ? `${controlId}-hint` : undefined;
  const errorId = hasContent(error) ? `${controlId}-error` : undefined;
  const helpId = help ? `${controlId}-help` : undefined;
  return {
    controlId,
    hintId,
    errorId,
    helpId,
    describedBy: [describedBy, hintId, errorId, helpId].filter(Boolean).join(' ') || undefined,
  };
}

type FieldLayoutProps = FieldContent & {
  controlId: string;
  hintId?: string;
  errorId?: string;
  helpId?: string;
  children: ReactNode;
  choice?: boolean;
};

function FieldLayout({ label, hint, help, error, controlId, hintId, errorId, helpId, children, choice }: FieldLayoutProps) {
  const fieldLabel = choice
    ? <label className="form-choice" htmlFor={controlId}>{children}<span>{label}</span></label>
    : <label className="form-field__label" htmlFor={controlId}>{label}</label>;
  return (
    <div className="form-field">
      {helpId && help ? <div className="form-field__heading">
        {fieldLabel}
        <FieldHelp id={helpId} label={typeof label === 'string' ? label : '항목'}>{help}</FieldHelp>
      </div> : fieldLabel}
      {!choice && children}
      {hintId && <p id={hintId} className="field-hint">{hint}</p>}
      {errorId && <p id={errorId} className="field-error" role="alert">{error}</p>}
    </div>
  );
}

export function TextField({ label, hint, help, error, id, className, type = 'text', 'aria-describedby': describedBy, 'aria-invalid': invalid, ...props }: TextFieldProps) {
  const field = useField(id, hint, error, describedBy, help);
  return (
    <FieldLayout {...field} label={label} hint={hint} help={help} error={error}>
      <input {...props} id={field.controlId} type={type} className={['form-control', className].filter(Boolean).join(' ')} aria-describedby={field.describedBy} aria-invalid={field.errorId ? true : invalid} />
    </FieldLayout>
  );
}

export function SelectField({ label, hint, help, error, id, className, 'aria-describedby': describedBy, 'aria-invalid': invalid, ...props }: SelectFieldProps) {
  const field = useField(id, hint, error, describedBy, help);
  return (
    <FieldLayout {...field} label={label} hint={hint} help={help} error={error}>
      <SelectControl {...props} id={field.controlId} className={className} aria-describedby={field.describedBy} aria-invalid={field.errorId ? true : invalid} />
    </FieldLayout>
  );
}

export function TextareaField({ label, hint, help, error, id, className, 'aria-describedby': describedBy, 'aria-invalid': invalid, ...props }: TextareaFieldProps) {
  const field = useField(id, hint, error, describedBy, help);
  return (
    <FieldLayout {...field} label={label} hint={hint} help={help} error={error}>
      <textarea {...props} id={field.controlId} className={['form-control', className].filter(Boolean).join(' ')} aria-describedby={field.describedBy} aria-invalid={field.errorId ? true : invalid} />
    </FieldLayout>
  );
}

export function CheckboxField({ label, hint, help, error, id, className, 'aria-describedby': describedBy, 'aria-invalid': invalid, ...props }: CheckboxFieldProps) {
  const field = useField(id, hint, error, describedBy, help);
  return (
    <FieldLayout {...field} label={label} hint={hint} help={help} error={error} choice>
      <input {...props} id={field.controlId} type="checkbox" className={className} aria-describedby={field.describedBy} aria-invalid={field.errorId ? true : invalid} />
    </FieldLayout>
  );
}
