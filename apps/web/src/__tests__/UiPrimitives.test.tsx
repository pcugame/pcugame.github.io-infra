/* @vitest-environment jsdom */

import { createRef } from 'react';
import type { FormEvent } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button, CheckboxField, FormSection, SelectField, TextareaField, TextField } from '../components/ui';

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
