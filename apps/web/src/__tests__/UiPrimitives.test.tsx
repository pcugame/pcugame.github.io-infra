/* @vitest-environment jsdom */

import { createRef } from 'react';
import type { FormEvent } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DialogFrame, ProgressBar, Button, CheckboxField, FormSection, SelectField, TextareaField, TextField } from '../components/ui';

afterEach(cleanup);

describe('UI primitives', () => {
  it('defaults buttons to a non-submitting native button and supports explicit submit, refs and disabled', () => {
    const onSubmit = vi.fn((event: FormEvent<HTMLFormElement>) => event.preventDefault());
    const onClick = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    render(
      <form onSubmit={onSubmit}>
        <Button ref={ref} onClick={onClick} variant="secondary" size="small" className="extra">Preview</Button>
        <Button type="submit">Save</Button>
        <Button disabled onClick={onClick}>Unavailable</Button>
      </form>,
    );
    expect(ref.current).toBe(screen.getByRole('button', { name: 'Preview' }));
    expect(ref.current?.classList.contains('extra')).toBe(true);
    fireEvent.click(ref.current!);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Unavailable' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('associates text labels, hints, errors and caller descriptions while preserving native input props and refs', () => {
    const ref = createRef<HTMLInputElement>();
    const onChange = vi.fn();
    const { rerender } = render(<>
      <p id="external">Shared help</p>
      <TextField label="Address" hint="Use a valid address" error="Invalid address" aria-describedby="external" ref={ref} onChange={onChange} required maxLength={50} />
    </>);
    const input = screen.getByLabelText('Address') as HTMLInputElement;
    expect(ref.current).toBe(input);
    expect(input.required).toBe(true);
    expect(input.maxLength).toBe(50);
    const id = input.id;
    expect(input.getAttribute('aria-describedby')?.split(' ').map((descriptionId) => document.getElementById(descriptionId)?.textContent)).toEqual(['Shared help', 'Use a valid address', 'Invalid address']);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').id).toBe(`${id}-error`);
    fireEvent.change(input, { target: { value: 'example' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    rerender(<><p id="external">Shared help</p><TextField label="Address" ref={ref} aria-invalid="grammar" /></>);
    expect(screen.getByLabelText('Address').id).toBe(id);
    expect(input.hasAttribute('aria-describedby')).toBe(false);
    expect(input.getAttribute('aria-invalid')).toBe('grammar');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('treats empty hint and validation strings as absent', () => {
    const { rerender } = render(<TextField label="Title" hint="" error="" />);
    const input = screen.getByLabelText('Title');
    expect(input.hasAttribute('aria-describedby')).toBe(false);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(<TextField label="Title" error="Required" />);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe('Required');
    rerender(<TextField label="Title" error="" />);
    expect(input.hasAttribute('aria-describedby')).toBe(false);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps generated IDs unique and forwards select and textarea behavior', () => {
    const selectRef = createRef<HTMLSelectElement>();
    const textareaRef = createRef<HTMLTextAreaElement>();
    const onSelect = vi.fn();
    const onText = vi.fn();
    render(<>
      <SelectField label="Mode" ref={selectRef} defaultValue="draft" onChange={onSelect} hint="Choose one">
        <option value="draft">Draft</option><option value="published">Published</option>
      </SelectField>
      <TextareaField label="Notes" ref={textareaRef} onChange={onText} rows={4} error="Notes required" />
      <TextField label="Other" disabled />
    </>);
    const select = screen.getByLabelText('Mode') as HTMLSelectElement;
    const textarea = screen.getByLabelText('Notes') as HTMLTextAreaElement;
    expect(selectRef.current).toBe(select);
    expect(textareaRef.current).toBe(textarea);
    expect(select.value).toBe('draft');
    expect(textarea.rows).toBe(4);
    expect(new Set([select.id, textarea.id, screen.getByLabelText('Other').id]).size).toBe(3);
    expect(document.getElementById(select.getAttribute('aria-describedby')!)?.textContent).toBe('Choose one');
    expect(textarea.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
    expect(textarea.getAttribute('aria-invalid')).toBe('true');
    expect((screen.getByLabelText('Other') as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(select, { target: { value: 'published' } });
    fireEvent.change(textarea, { target: { value: 'New note' } });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledTimes(1);
  });

  it('uses native checkbox labels, descriptions, disabled and refs', () => {
    const ref = createRef<HTMLInputElement>();
    const onChange = vi.fn();
    const { rerender } = render(<CheckboxField id="consent" label="Consent" hint="Optional" error="Please confirm" aria-describedby="policy" ref={ref} onChange={onChange} />);
    const checkbox = screen.getByRole('checkbox', { name: 'Consent' }) as HTMLInputElement;
    expect(ref.current).toBe(checkbox);
    expect(checkbox.getAttribute('aria-describedby')).toBe('policy consent-hint consent-error');
    expect(checkbox.getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(screen.getByText('Consent'));
    expect(checkbox.checked).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    rerender(<CheckboxField id="consent" label="Consent" disabled ref={ref} onChange={onChange} />);
    expect(checkbox.disabled).toBe(true);
    fireEvent.click(screen.getByText('Consent'));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('preserves fieldset semantics and native disabled group behavior', () => {
    const ref = createRef<HTMLFieldSetElement>();
    const onClick = vi.fn();
    render(<FormSection legend="Upload limits" disabled ref={ref} name="limits">
      <TextField label="Limit" type="number" min={1} />
      <Button onClick={onClick}>Apply</Button>
    </FormSection>);
    const group = screen.getByRole('group', { name: 'Upload limits' });
    expect(ref.current).toBe(group);
    expect(ref.current?.disabled).toBe(true);
    expect(ref.current?.name).toBe('limits');
    expect(screen.getByLabelText('Limit').matches(':disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Apply' }).matches(':disabled')).toBe(true);
    // click() uses the browser's disabled-fieldset behavior, unlike synthetic fireEvent.click.
    (screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).click();
    expect(onClick).not.toHaveBeenCalled();
  });
});


describe('native presentation primitives', () => {
  it('forwards dialog refs and cancellation policy, keeping unsaved input mounted when closed', () => {
    const ref = createRef<HTMLDialogElement>();
    const cancel = vi.fn((event: React.SyntheticEvent) => event.preventDefault());
    const close = vi.fn();
    const view = (open: boolean) => <DialogFrame open={open} ref={ref} aria-label="Settings" onCancel={cancel} onClose={close}>
      <TextField label="Draft" defaultValue="original" />
    </DialogFrame>;
    const { rerender } = render(view(true));
    const input = screen.getByLabelText('Draft') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'unsaved' } });
    expect(ref.current).toBe(screen.getByRole('dialog', { name: 'Settings' }));
    const event = new Event('cancel', { cancelable: true });
    fireEvent(ref.current!, event);
    expect(cancel).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    fireEvent(ref.current!, new Event('close'));
    expect(close).toHaveBeenCalledOnce();
    rerender(view(false));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(input.isConnected).toBe(true);
    rerender(view(true));
    expect(screen.getByLabelText('Draft')).toBe(input);
    expect(input.value).toBe('unsaved');
  });

  it('distinguishes indeterminate progress from zero and preserves a custom maximum', () => {
    const ref = createRef<HTMLProgressElement>();
    const { rerender } = render(<ProgressBar ref={ref} aria-label="Transfer" />);
    const bar = screen.getByRole('progressbar', { name: 'Transfer' }) as HTMLProgressElement;
    expect(ref.current).toBe(bar);
    expect(bar.hasAttribute('value')).toBe(false);
    expect(bar.position).toBe(-1);
    expect(bar.max).toBe(100);
    rerender(<ProgressBar ref={ref} aria-label="Transfer" value={0} />);
    expect(bar.position).toBe(0);
    rerender(<ProgressBar ref={ref} aria-label="Transfer" value={3} max={4} />);
    expect(bar.position).toBe(.75);
  });

  it('preserves native disabled fieldsets across panel/plain presentation changes', () => {
    const view = (variant?: 'plain') => <FormSection legend="Details" variant={variant} disabled><TextField label="Title" defaultValue="Draft" /></FormSection>;
    const { rerender } = render(view());
    const input = screen.getByLabelText('Title');
    expect(input.closest('fieldset')?.classList.contains('form-section--panel')).toBe(true);
    rerender(view('plain'));
    expect(screen.getByLabelText('Title')).toBe(input);
    expect(input.matches(':disabled')).toBe(true);
    expect(input.closest('fieldset')?.classList.contains('form-section--plain')).toBe(true);
  });
});
